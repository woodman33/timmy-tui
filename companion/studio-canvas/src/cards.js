// Round R4 (H75): Timmy Canvas's own drawn cards: a workflow card, a parameter card and a result card, tldraw shapes drawn
// from the same records the board uses (GET /api/project?detail=1, src/studio/card-detail.ts). Each says plainly whether it
// is executable now or a diagram, keeps its technical detail behind Details, and follows its record: the page reads the
// project every few seconds (faster while a job runs) and a card shows what the records say now; its shape keeps the last
// reading (and when it was taken) so a canvas reopened without Timmy shows it, said as such.
//
// Acting: a workflow card's Run, a parameter card's Save and Rebuild never run here or in the canvas server. They are sent
// to the canvas server (POST /api/project/act), which carries them to the Timmy REPL that holds the project; the REPL checks
// each against the live board's state and runs it through the live board's own path, as its own job (src/repl/canvas-
// actions.ts). A card is executable only when all of this holds: the canvas shows the card's project, a REPL takes its
// actions now, and this page has a session (it was opened by /canvas open, whose one-time grant it traded for one). Else the
// card says which is missing and gives the typed command instead of a button.
//
// R4 (H81): what code on this page can and cannot do. The agent's canvas bridge runs code on this page (canvas.js, as an
// async function, after the REPL's NEEDS YOU box for canvas_exec asked about it), in this page's own realm: such code can
// replace any global (fetch, JSON, Object.create, Event.prototype.target, WeakMap.prototype.get), define getters on
// Object.prototype (which the browser consults for every member a request's init leaves out), add listeners that run before
// this module's, and rewrite the page. So:
//   - everything an action and a reading of the cards rely on is taken as this module is evaluated (SAFE, below), before
//     tldraw starts and before the bridge connects; each request's init and headers are objects with no prototype, every
//     member this module relies on set on them, so the session token is never handed to code through a prototype;
//   - the session token lives only in this module's closure (never on window, in storage, in the page's text or the canvas);
//   - an action goes out only for a click the browser marks as the person's own (event.isTrusted), on a button this module
//     drew, and it is the action this module recorded for that button when it drew it (never an attribute, a field or the
//     focus read when the click comes), checked again against the card's record and the reading now.
// What code on the page can still do: change what the page and its cards show, block a click, and move or cover a card's
// button so that a person's next click lands on it. It cannot read the session or turn a click on one button into another
// button's action. The barrier for code on the page is the REPL's own NEEDS YOU box for canvas_exec, asked before every
// script (src/repl/approvals.ts); the REPL then checks each action against the live board's state, asks NEEDS YOU before a
// risky block, and records it. Every text is set as text (React escapes it); nothing is markup.
//
// R4 (H100): each card names the operation its record names (one request: src/ops/context.ts), as Timmy read it from the
// record at this reading, on its face ("operation o1a2b3c4d", or "no operation:" and why) and in Details (with the request and
// state the operation's own record gives, and /op to type in Timmy); a card no longer followed shows it as last read. And
// "Place this operation" (placeOperation) places an operation's workflow, flow and result cards at once, left to right in
// the order they ran, linked by arrows bound to them; a second press adds only what ran since and leaves alone what the
// person did (./operations.js has its rules).
//
// Nothing here imports anything but ./operations.js (pure rules): canvas.js hands in React and tldraw's classes, so the rules
// below run in Node's tests too.
import { operationLine, placementKey, placementPlan, placementWords, PLACEMENTS, readPlacement, ROW_GAP, rowLayout } from './operations.js';

// R4 (H83): the same session is what loads and saves the canvas, reads its jobs and a project's highlights, and joins the
// agent's bridge (canvas.js asks this module for each, so the token never leaves it): a page without one loads no canvas and
// says so. The bridge's WebSocket is made with the constructor taken at load, its session sent as a subprotocol from an
// iterable with no prototype (so no iterator page script could replace sees it), and the server selects the other protocol,
// timmy-canvas, so the socket never names the session back.

// ── R4 (H81): what actions and readings rely on, taken as this module is evaluated ─────────────────────────────────────
const G = globalThis;
const descriptor = (o, k) => (o ? G.Object.getOwnPropertyDescriptor(o, k) : undefined);
const SAFE = G.Object.freeze({
  apply: G.Reflect.apply,
  create: G.Object.create,
  keys: G.Object.keys,
  setPrototypeOf: G.Object.setPrototypeOf,
  isArray: G.Array.isArray,
  stringify: G.JSON.stringify,
  parse: G.JSON.parse,
  isFinite: G.Number.isFinite,
  WeakMap: G.WeakMap,
  weakGet: G.WeakMap.prototype.get,
  weakSet: G.WeakMap.prototype.set,
  weakDelete: G.WeakMap.prototype.delete,
  fetch: typeof G.fetch === 'function' ? G.Function.prototype.bind.call(G.fetch, G) : null,
  text: G.Response ? G.Response.prototype.text : null,
  ok: descriptor(G.Response && G.Response.prototype, 'ok')?.get ?? null,
  status: descriptor(G.Response && G.Response.prototype, 'status')?.get ?? null,
  target: descriptor(G.Event && G.Event.prototype, 'target')?.get ?? null,
  // R4 (H83): the bridge, and the highlights shown from memory
  WebSocket: typeof G.WebSocket === 'function' ? G.WebSocket : null,
  iterator: G.Symbol.iterator,
  blob: G.Response ? G.Response.prototype.blob : null,
  objectURL: G.URL && typeof G.URL.createObjectURL === 'function' ? G.URL.createObjectURL : null,
  revokeURL: G.URL && typeof G.URL.revokeObjectURL === 'function' ? G.URL.revokeObjectURL : null,
  URL: G.URL,
  encode: G.encodeURIComponent,
});
/** R4 (H83): the bridge protocol the server selects (the session goes beside it, never back). */
export const CANVAS_PROTOCOL = 'timmy-canvas';

/**
 * A JSON value copied into objects (and arrays) with no prototype, so JSON.stringify finds no toJSON or getter through
 * Object.prototype or Array.prototype while it writes an action. Only plain JSON values are kept.
 */
function bare(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return SAFE.isFinite(v) ? v : null;
  if (typeof v !== 'object') return null;
  if (SAFE.isArray(v)) {
    // its prototype goes first, so no setter on Array.prototype or Object.prototype sees (or keeps) an element
    const a = SAFE.setPrototypeOf([], null);
    for (let i = 0; i < v.length; i++) a[i] = bare(v[i]);
    return a;
  }
  const o = SAFE.create(null);
  const keys = SAFE.keys(v);
  for (let i = 0; i < keys.length; i++) o[keys[i]] = bare(v[keys[i]]);
  return o;
}

/**
 * One request's init, with no prototype and every member this module relies on set on it; its headers likewise (a record
 * with no prototype: no getter on Object.prototype, and no iterator on any prototype, is ever asked for them). `token`: the
 * session to send, or null; `json`: the body, or undefined for none. R4 (H83): `o.raw`, a body already written as text (the
 * canvas document, which is the page's own drawing, never the session), and `o.keepalive` (a save as the page closes).
 */
function requestInit(method, token, json, o = {}) {
  const headers = SAFE.create(null);
  if (json !== undefined || typeof o.raw === 'string') headers['Content-Type'] = 'application/json';
  if (typeof token === 'string' && token) headers.Authorization = `Bearer ${token}`;
  const init = SAFE.create(null);
  init.method = method;
  init.headers = headers;
  if (typeof o.raw === 'string') init.body = o.raw;
  else if (json !== undefined) init.body = SAFE.stringify(bare(json));
  init.mode = 'same-origin';
  init.credentials = 'omit';
  init.cache = 'no-store';
  init.redirect = 'error';
  init.referrer = '';
  init.referrerPolicy = 'no-referrer';
  init.integrity = '';
  init.keepalive = o.keepalive === true;
  init.signal = null;
  init.window = null;
  return init;
}

/**
 * A request to the canvas server through the fetch taken at load: its status and its body as JSON (null when it is not).
 * Only startSession's answer holds a session token, and it is read before tldraw starts and before the bridge connects
 * (canvas.js start()), so no code of the agent's is on the page while it is. R4 (H83): `o.array` keeps a list body (the jobs).
 */
async function request(path, method, token, json, o = {}) {
  if (!SAFE.fetch || !SAFE.text) throw new Error('this page cannot make requests');
  const r = await SAFE.fetch(path, requestInit(method, token, json, o));
  const status = SAFE.status ? SAFE.apply(SAFE.status, r, []) : 0;
  const ok = SAFE.ok ? SAFE.apply(SAFE.ok, r, []) === true : false;
  let body = null;
  try { body = SAFE.parse(await SAFE.apply(SAFE.text, r, [])); } catch { body = null; }
  return { status, ok, body: body && typeof body === 'object' && (o.array || !SAFE.isArray(body)) ? body : null };
}

/**
 * R4 (H83): the subprotocols a page joins the bridge with: timmy-canvas, then its session. An iterable with no prototype whose
 * iterator and every step have none either, so no Array.prototype, iterator prototype or Object.prototype member page script
 * could replace is asked for while the WebSocket constructor reads it.
 */
function bridgeProtocols(session) {
  const first = CANVAS_PROTOCOL;
  const second = `timmy-session.${session}`;
  const list = SAFE.create(null);
  list[SAFE.iterator] = function protocols() {
    let i = 0;
    const it = SAFE.create(null);
    it.next = function next() {
      const step = SAFE.create(null);
      step.done = i >= 2;
      step.value = i === 0 ? first : i === 1 ? second : undefined;
      i += 1;
      return step;
    };
    return it;
  };
  return list;
}

/** R4 (H83): what a card of another project holds in place of its kept detail, as the server withheld it (or null). */
export function withheldData(data) {
  return data && typeof data === 'object' && data.type === 'withheld' && typeof data.words === 'string' ? data : null;
}

/** R4 (H83): what a page opened without a grant says (it loads no canvas). */
export const NO_GRANT = 'This page was opened without a grant from Timmy, so it loads no canvas: Timmy opens the canvas page with a one-time grant, and a page opened by its address, a bookmark or a reload has none.';
/** R4 (H83): what a page whose session ended says. */
export const ENDED = 'This page\'s session with Timmy has ended, so it loads, saves and acts no more.';
/** R4 (H88): what the panel says while this page's session counts for the project shown. */
export const CAN_ACT = 'This page was opened by Timmy: its executable cards can act.';

/** The shape type of each drawn card, and which project card kinds each one draws. */
export const CARD_SHAPES = { workflow: 'timmy-workflow', params: 'timmy-params', result: 'timmy-result' };
const KIND_TO_TYPE = { workflow: 'workflow', params: 'params', flow: 'result', vox: 'result', run: 'result' };
const TYPE_OF_SHAPE = Object.fromEntries(Object.entries(CARD_SHAPES).map(([t, s]) => [s, t]));
const WIDTH = { workflow: 380, params: 360, result: 380 };

/** The drawn card a project card kind gets ('workflow', 'params', 'result'), or null (an unreadable record has none). */
export const drawnType = (kind) => KIND_TO_TYPE[kind] ?? null;
/** The tldraw shape type for a project card kind, or null. */
export const shapeTypeFor = (kind) => (drawnType(kind) ? CARD_SHAPES[drawnType(kind)] : null);
/** Whether a store record is one of these cards. */
export const isDrawnCard = (r) => !!r && r.typeName === 'shape' && r.type in TYPE_OF_SHAPE;

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** A result's check, in the word the card leads with. */
const CHECK_WORD = { verified: 'verified', stale: 'stale', unverified: 'not verified', none: 'receipt' };
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * What a card can do now, in words. `answer` is the last reading of the project (null before the first): GET
 * /api/project?detail=1 with this page's session, or (R4 H81) the plain card list with `detail: false` and `detailWhy` when
 * the page has no session that reads the detail. `session` whether this page holds one. A result card is always a diagram.
 */
export function cardMode(type, props, answer, session) {
  const diagram = (words, follows = false) => ({ executable: false, badge: 'diagram', words, follows });
  const name = props.project || 'its project';
  // R4 (H83): a card of another project, its kept detail withheld from this page: it says so, and how to read it
  const withheld = withheldData(props.data);
  if (withheld) return { ...diagram(one(withheld.words)), withheld: true };
  if (!answer) return diagram('Not read from Timmy yet.');
  // R4 (H83): the project was not read: this page's session does not count now (it ended, or the canvas shows another project)
  if (answer.refused) return diagram(`Not followed now: ${one(answer.refused)} Shown as last read.`);
  if (!answer.project) return diagram(`Not followed now: no project is named to this canvas (in Timmy: /canvas open). Shown as last read.`);
  if (answer.project.id !== props.projectId) return diagram(`Not followed now: the canvas shows ${answer.project.name}, not ${name}. Shown as last read.`);
  const card = (answer.cards || []).find((c) => c.id === props.card);
  if (!card) return diagram(`Its record is not in ${name} now: shown as last read.`);
  // R4 (H81): the detail (each block's command, each value) is read only with a session that counts: without one the card
  // is shown as last read, and says why
  if (answer.detail === false) return diagram(`${one(answer.detailWhy) || 'Its detail was not read: this page has no session that reads it.'} Shown as last read.`);
  if (type === 'result') return diagram('A diagram of its record, read from Timmy now: nothing runs from this card.', true);
  if (!answer.actions || answer.actions.holder !== true) return diagram(one(answer.actions?.words) || `No Timmy REPL takes ${name}'s actions now.`, true);
  if (!session) return diagram('Read from Timmy now, but this page cannot act: it was not opened by /canvas open in Timmy, or it was reloaded since. Type the command in Timmy, or /canvas open there.', true);
  return { executable: true, badge: 'executable', words: `Executable: its buttons are sent to the Timmy REPL that holds ${name}, which runs them as the live board's own actions.`, follows: true };
}

/** The live board's run action for one block of a workflow card, or null when /run cannot name it. */
export function runAct(detail, block) {
  if (!detail || detail.type !== 'workflow' || !detail.runnable) return null;
  const b = (detail.blocks || []).find((x) => x.name === block);
  return b && b.runnable ? { action: 'run', doc: detail.doc, block: b.name } : null;
}

/** The live board's rebuild action for a recipe parameter card, or null. */
export function rebuildAct(detail) {
  return detail && detail.type === 'params' && detail.rebuild && detail.recipe ? { action: 'rebuild', recipe: detail.recipe } : null;
}

/**
 * The live board's save for a parameter card: the values as typed (each as the board's own form reads it) and the sha256 the
 * file had when the card was drawn for editing (`base`), so a file changed meanwhile is refused, never written over.
 */
export function saveAct(detail, typed, base) {
  if (!detail || detail.type !== 'params' || !detail.save || !detail.save.offered) return null;
  const parameters = {};
  for (const v of detail.values || []) {
    const raw = Object.prototype.hasOwnProperty.call(typed, v.name) ? String(typed[v.name]) : String(v.value);
    const t = raw.trim();
    if (detail.engine === 'tray') parameters[v.name] = t !== '' && Number.isFinite(Number(t)) ? Number(t) : t;
    else if (v.kind === 'number') parameters[v.name] = NUMBER.test(t) ? Number(t) : raw;
    else if (v.kind === 'boolean') parameters[v.name] = t === 'true' ? true : t === 'false' ? false : raw;
    else parameters[v.name] = raw;
  }
  return detail.engine === 'tray'
    ? { action: 'set-params', recipe: detail.recipe, base: base ?? null, parameters }
    : { action: 'set-scad-params', model: detail.model, base: base ?? '', parameters };
}

/**
 * R4 (H81): whether the card's detail read now still offers the action a button was drawn with (`act`, as recorded when it was
 * drawn): the same block of the same document, the same recipe's rebuild, a save of the same file by the same path. A click
 * on a button whose card no longer offers its action sends nothing.
 */
export function offeredNow(act, detail) {
  if (!act || !detail) return false;
  if (act.action === 'run') { const a = runAct(detail, act.block); return !!a && a.doc === act.doc && a.block === act.block; }
  if (act.action === 'rebuild') { const a = rebuildAct(detail); return !!a && a.recipe === act.recipe; }
  if (act.action === 'set-params' || act.action === 'set-scad-params') {
    const a = saveAct(detail, {}, null);
    return !!a && a.action === act.action && (a.recipe ?? null) === (act.recipe ?? null) && (a.model ?? null) === (act.model ?? null);
  }
  return false;
}

/** A value as the card's field shows it. */
export const shownValue = (v) => (typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v));

/**
 * What a card keeps in its shape from a reading: the detail without what changes every second (a running run's time so far),
 * so the canvas is saved again only when the record says something new.
 */
export function keptDetail(detail) {
  if (!detail || detail.type !== 'result') return detail ?? null;
  return { ...detail, facts: (detail.facts || []).filter((f) => f.how !== 'so far') };
}

/** Whether a card's detail says a job of it still runs (the page then reads the project more often). */
export function stillRunning(detail) {
  if (!detail) return false;
  if (detail.type === 'workflow') return detail.running === true;
  if (detail.type === 'params') return !!detail.build && detail.build.tone === 'running';
  return detail.verdict && detail.verdict.tone === 'running';
}

/** A time as a card says it: the clock time (the full time is its tooltip). */
function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── the shapes and their runtime (the browser only) ────────────────────────────

/**
 * The three shape utils and the runtime that feeds and acts for them. `deps`: React, BaseBoxShapeUtil, HTMLContainer, T,
 * atom, useValue, resizeBox (from tldraw); createShapeId; editor() (the live editor); place(editor, size) → where a new card goes;
 * reveal(editor, ids); grant (the one-time code this page was opened with, or null).
 */
export function createCards(deps) {
  const { React, BaseBoxShapeUtil, HTMLContainer, T, atom, useValue, resizeBox } = deps;
  const h = React.createElement;
  /** The last reading of the project, for every card. */
  const live = atom('timmy cards: the project as read', { answer: null, error: null });
  /** Each card's action in flight and its last answer, by shape id. */
  const acts = atom('timmy cards: actions', {});
  // The session: this closure only.
  let token = null;
  const session = atom('timmy cards: session', { state: 'none', words: NO_GRANT });
  let poll = async () => {};
  let fastUntil = 0;
  /**
   * R4 (H81): each button this module drew, by its element, with the action it sends and the card it belongs to, recorded
   * as it was drawn (actRef, below). A click sends only what is recorded here for the very element clicked.
   */
  const drawn = new SAFE.WeakMap();
  const recorded = (el) => SAFE.apply(SAFE.weakGet, drawn, [el]);

  const setAct = (id, v) => acts.update((all) => ({ ...all, [id]: { ...(all[id] || {}), ...v } }));

  /**
   * Trades the grant this page was opened with for a session, once; says how it went. It runs before tldraw starts and before
   * the agent's bridge connects (canvas.js start()), so no code of the agent's is on the page while the token is read.
   */
  async function startSession() {
    const grant = deps.grant;
    if (!grant) return session.get();
    try {
      const r = await request('/api/project/session', 'POST', null, { grant });
      const body = r.body || {};
      if (r.ok && body.ok === true && typeof body.token === 'string' && /^[0-9a-f]{64}$/.test(body.token)) {
        token = body.token;
        session.set({ state: 'ok', words: CAN_ACT });
      } else {
        session.set({ state: 'refused', words: one(body.error) || `Timmy answered ${r.status} for this page's grant.` });
      }
    } catch (e) {
      session.set({ state: 'refused', words: `The grant could not be traded: ${e instanceof Error ? e.message : String(e)}` });
    }
    return session.get();
  }

  /** R4 (H81): a session the server said does not count for the project shown (until when not to ask again, and why). */
  const notFor = { until: 0, why: '' };
  /** R4 (H88): told when the session's state changes (the panel's line under it follows it: canvas.js showSession). */
  let onSession = () => {};
  /**
   * R4 (H88; the Mac run r23): the session as it counts now. One the server says does not count for the project shown now
   * (another project, or another REPL, holds the canvas) is kept, and said so: its cards are diagrams until it counts again
   * (the panel had kept saying they "can act"); once a reading counts again, they can act again.
   */
  function notNow(why) {
    if (!token) return;
    session.set({ state: 'paused', words: `${why} Until it counts again, this page's cards are diagrams: nothing on them acts.` });
    onSession();
  }
  function countsAgain() {
    if (!token || session.get().state !== 'paused') return;
    session.set({ state: 'ok', words: CAN_ACT });
    onSession();
  }

  /**
   * R4 (H83): a refusal the server gave this page's session. One that ended (or that the server never made, or no longer keeps)
   * is let go for good: the page then loads, saves and acts no more, and says so. Returns the words.
   */
  function noted(r, fallback) {
    const said = (r && r.body) || {};
    const why = one(said.error) || fallback;
    if (r && r.status === 401 && (said.session === 'expired' || said.session === 'unknown' || said.session === 'none')) {
      token = null;
      session.set({ state: 'refused', words: why });
      onSession();
    } else if (r && r.status === 401 && (said.session === 'project' || said.session === 'holder')) notNow(why); // R4 (H88)
    return why;
  }

  /** R4 (H83): a reading this page was refused: no project, the refusal in words (the panel and the cards say it). */
  const refusedReading = (why) => ({ ok: false, refused: why, message: why, project: null, board: null, cards: [], notes: [], detail: false, detailWhy: why, madeAt: new Date().toISOString() });

  /**
   * R4 (H81): one reading of the project for the panel and the cards: GET /api/project?detail=1 (each card's detail) with this
   * page's session. R4 (H83): the card list is read with a session too, so without one that counts now there is no reading:
   * the answer says why (`refused`). A session given for another project, or by another REPL, is asked again in 30 s.
   */
  async function read() {
    if (!token) return refusedReading(session.get().words);
    if (Date.now() < notFor.until) return refusedReading(notFor.why);
    const r = await request('/api/project?detail=1', 'GET', token);
    if (r.ok && r.body && r.body.ok === true) { notFor.until = 0; countsAgain(); return { ...r.body, detail: true }; }
    if (r.status !== 401) throw new Error(`Timmy answered ${r.status} for the project`);
    const why = noted(r, 'Timmy did not let this page read the project.');
    if (token) {
      // given for another project, or by another REPL: asked again in 30 s
      notFor.until = Date.now() + 30_000;
      notFor.why = why;
    }
    return refusedReading(why);
  }

  // ── R4 (H83): the canvas itself, its settings, its jobs, a highlight and the bridge: each with this page's session ──
  /** Whether this page holds a session (it may still not count now: the server then refuses and says why). */
  const hasSession = () => token !== null;
  /** The page's settings: the license key comes only with the session. */
  async function config() { return request('/studio-config.json', 'GET', token); }
  /** The canvas as saved, every card of another project with its kept detail withheld (the server's part). */
  async function loadDocument() {
    if (!token) return { status: 0, ok: false, body: null, why: session.get().words };
    const r = await request('/api/canvas/document', 'GET', token);
    return r.ok ? r : { ...r, why: noted(r, `Timmy answered ${r.status} for the saved canvas.`) };
  }
  /** Saves the canvas (`text`: the document as JSON text, written by canvas.js); as the page closes, `keepalive`. */
  async function saveDocument(text, keepalive = false) {
    if (!token) return { status: 0, ok: false, body: { ok: false, error: session.get().words } };
    const r = await request('/api/canvas/document', 'PUT', token, undefined, { raw: text, keepalive });
    if (r.status === 401) noted(r, 'Timmy refused this page\'s save.');
    return r;
  }
  /** The canvas jobs, newest first; null when they cannot be read now (a session that does not count is asked again in 30 s). */
  async function jobs() {
    if (!token || Date.now() < notFor.until) return null;
    const r = await request('/api/canvas/jobs', 'GET', token, undefined, { array: true });
    if (r.status === 401) {
      const why = noted(r, 'Timmy did not let this page read the canvas jobs.');
      if (token) { notFor.until = Date.now() + 30_000; notFor.why = why; }
    }
    return r.ok && SAFE.isArray(r.body) ? r.body : null;
  }
  /** A highlight of the project, read with the session and shown from memory (an object URL); null when it is not read. */
  async function image(path) {
    if (!token || !SAFE.fetch || !SAFE.blob || !SAFE.objectURL) return null;
    const r = await SAFE.fetch(`/api/project/image?p=${SAFE.apply(SAFE.encode, G, [String(path)])}`, requestInit('GET', token));
    if (!(SAFE.ok && SAFE.apply(SAFE.ok, r, []) === true)) return null;
    const b = await SAFE.apply(SAFE.blob, r, []);
    return SAFE.apply(SAFE.objectURL, SAFE.URL, [b]);
  }
  const forget = (url) => { if (url && SAFE.revokeURL) { try { SAFE.apply(SAFE.revokeURL, SAFE.URL, [url]); } catch { /* gone */ } } };
  /** The agent's bridge: a WebSocket joined with this page's session (null without one). */
  function bridgeSocket(url) {
    if (!token || !SAFE.WebSocket) return null;
    return new SAFE.WebSocket(url, bridgeProtocols(token));
  }
  /** The bridge closed this page for good (its session ended): it is let go, and the page says so. */
  function sessionEnded(words) {
    token = null;
    session.set({ state: 'refused', words: one(words) || ENDED });
    onSession();
  }

  /** One action of one card, sent to the REPL that holds the project; the answer is kept on the card. */
  async function act(shapeId, body) {
    if (!token) { setAct(shapeId, { busy: false, answer: { ok: false, text: 'This page has no session: /canvas open in Timmy opens one that has.' } }); return; }
    setAct(shapeId, { busy: true, answer: null });
    let answer;
    try {
      // the request's init and headers have no prototype, and its body is written from objects with none (requestInit)
      const r = await request('/api/project/act', 'POST', token, body);
      const got = r.body || {};
      answer = { ok: r.ok && got.ok === true, status: r.status, text: one(got.text) ? String(got.text) : one(got.error) || `Timmy answered ${r.status}.`, act: body.act.action };
    } catch (e) {
      answer = { ok: false, status: 0, text: `The action did not reach Timmy Canvas: ${e instanceof Error ? e.message : String(e)}`, act: body.act.action };
    }
    setAct(shapeId, { busy: false, answer, ...(answer.ok && body.act.action.startsWith('set-') ? { saved: Date.now() } : {}) });
    fastUntil = Date.now() + 60_000;
    void poll();
  }

  /**
   * R4 (H81): a ref for a button this module draws, recording the action it sends as it is drawn: the card's shape, its type,
   * card and project, the action (from the reading the card was drawn from, and for a save the values typed in this card's own
   * state), and whether the button is enabled. React calls it again on every drawing, so the record is always the drawing's.
   */
  const actRef = (shape, type, act, enabled) => (el) => {
    if (!el || !act) return undefined;
    const rec = { shapeId: shape.id, type, card: shape.props.card, projectId: shape.props.projectId, act, enabled: enabled === true };
    SAFE.apply(SAFE.weakSet, drawn, [el, rec]);
    return () => { if (recorded(el) === rec) SAFE.apply(SAFE.weakDelete, drawn, [el]); };
  };

  /**
   * Every button that acts goes through here, from the browser's own click event. R4 (H81): it acts only for a click the
   * browser marks as the person's (isTrusted: a pointer, or Enter or Space on the focused button; never element.click() or a
   * dispatched event), whose target (read with the getter taken at load) is a button this module drew and recorded, enabled
   * when drawn, on a card whose shape, project and card are still the ones recorded, while the card is executable and its
   * reading still offers that action. What it sends is the recorded action: no attribute, field or focus of the page is read.
   */
  function onClick(e) {
    if (e.isTrusted !== true || !SAFE.target) return;
    const target = SAFE.apply(SAFE.target, e, []);
    const rec = target ? recorded(target) : undefined;
    if (!rec || !rec.enabled) return;
    if ((acts.get()[rec.shapeId] || {}).busy) return;
    const editor = deps.editor();
    const shape = editor ? editor.getShape(rec.shapeId) : null;
    if (!shape || !isDrawnCard(shape) || TYPE_OF_SHAPE[shape.type] !== rec.type || shape.props.card !== rec.card || shape.props.projectId !== rec.projectId) return;
    const now = live.get().answer;
    const mode = cardMode(rec.type, shape.props, now, token !== null);
    if (!mode.executable) return;
    const card = (now.cards || []).find((c) => c.id === rec.card);
    if (!offeredNow(rec.act, card && card.detail)) return;
    void act(rec.shapeId, { project: rec.projectId, card: rec.card, act: rec.act });
  }
  if (typeof document !== 'undefined') document.addEventListener('click', onClick, true);

  /**
   * A reading of the project: every card follows it, and each placed card keeps it (only what changed is written). R4 (H81):
   * a reading without the detail keeps each card's last detail as it was.
   */
  function onAnswer(answer) {
    live.set({ answer, error: null });
    const editor = deps.editor();
    if (!editor || !answer || !answer.project) return;
    const updates = [];
    for (const r of editor.store.allRecords()) {
      if (!isDrawnCard(r) || r.props.projectId !== answer.project.id) continue;
      const card = (answer.cards || []).find((c) => c.id === r.props.card);
      if (!card) {
        if (!r.props.gone) updates.push({ id: r.id, type: r.type, props: { gone: true, readAt: answer.madeAt } });
        continue;
      }
      if (answer.detail === false) {
        if (r.props.gone || r.props.title !== card.title || r.props.command !== card.command) updates.push({ id: r.id, type: r.type, props: { gone: false, title: card.title, command: card.command } });
        continue;
      }
      const kept = keptDetail(card.detail);
      if (r.props.gone || JSON.stringify(kept) !== JSON.stringify(r.props.data) || r.props.title !== card.title || r.props.command !== card.command) {
        updates.push({ id: r.id, type: r.type, props: { data: kept, readAt: answer.madeAt, gone: false, title: card.title, command: card.command } });
      }
    }
    if (updates.length) editor.run(() => editor.updateShapes(updates), { history: 'ignore' });
  }

  /** Whether the page should read the project again soon (a job of a card runs, or an action was just sent). */
  function wantsFast() {
    if (Date.now() < fastUntil) return true;
    const a = live.get().answer;
    const editor = deps.editor();
    if (!a || !editor) return false;
    return editor.store.allRecords().some((r) => isDrawnCard(r) && r.props.projectId === a.project?.id && stillRunning((a.cards || []).find((c) => c.id === r.props.card)?.detail));
  }

  /**
   * A drawn card's props, from the reading it is placed from. R4 (H81): a reading without the detail places the card with
   * none (it says why, and "never read").
   */
  const propsFor = (card, answer, type) => ({
    w: WIDTH[type], h: 160, card: card.id, kind: card.kind, projectId: answer.project.id, project: answer.project.name, title: card.title, command: card.command,
    data: answer.detail === false ? null : keptDetail(card.detail), readAt: answer.detail === false ? '' : answer.madeAt, open: false, gone: false,
  });

  /** One frame, or 50 ms where frames do not come (a hidden tab draws none): never a wait that does not end. */
  const frame = () => new Promise((done) => {
    const t = setTimeout(done, 50);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { clearTimeout(t); done(); });
  });

  /**
   * R4 (H100): brings shapes into view once their heights have stopped changing (a drawn card is made 160 tall and then
   * follows its content, Frame's layout effect): revealed at once, a tall card's lower part, its Save or Run with it, could
   * sit under tldraw's toolbar. At most 24 frames; then as it is.
   */
  async function revealSized(editor, ids) {
    let last = '';
    for (let i = 0; i < 24; i++) {
      await frame();
      const now = ids.map((id) => { const s = editor.getShape(id); return s ? `${s.props.h}` : '-'; }).join(',');
      if (now === last) break;
      last = now;
    }
    try { deps.reveal(editor, ids.filter((id) => editor.getShape(id))); } catch { /* showing them is a courtesy */ }
  }

  /** Places card `id` of the project as it is now, as its drawn card. */
  async function place(id, answer, editor = deps.editor()) {
    if (!answer.project) throw new Error(answer.message || 'No project is named to this canvas.');
    const card = (answer.cards || []).find((c) => c.id === id);
    if (!card) throw new Error(`No card ${JSON.stringify(String(id)).slice(0, 120)} in ${answer.project.name} now.`);
    const type = drawnType(card.kind);
    if (!type) throw new Error(`${card.title} has no drawn card (an unreadable record): Place on canvas makes a note of it.`);
    // Beside the drawn cards already on this page (right of the rightmost), so cards placed one after another never cover
    // each other; the first goes where the panel's notes go.
    const others = editor.getCurrentPageShapes().filter(isDrawnCard).map((s) => editor.getShapePageBounds(s.id)).filter(Boolean);
    const right = others.reduce((a, b) => (!a || b.maxX > a.maxX ? b : a), null);
    const at = right ? { x: Math.round(right.maxX + 32), y: Math.round(right.minY) } : deps.place(editor, { w: WIDTH[type], h: 160 });
    const shapeId = deps.createShapeId();
    editor.createShape({ id: shapeId, type: CARD_SHAPES[type], x: at.x, y: at.y, props: propsFor(card, answer, type) });
    editor.select(shapeId);
    try { deps.reveal(editor, [shapeId]); } catch { /* showing it is a courtesy */ }
    // R4 (H100): and again once it has its height, so its lower part (its buttons) is not left under tldraw's toolbar
    await revealSized(editor, [shapeId]);
    return { placed: true, shape: shapeId, type: CARD_SHAPES[type], card: { id: card.id, title: card.title } };
  }

  /**
   * R4 (H100): an arrow from card `from` to card `to`, bound to both: tldraw moves its ends with the cards. An elbow arrow aimed
   * at each card's middle, so it runs at right angles between the edges that face each other, however tall each card grows
   * (a card's height follows its content). Returns the arrow's shape id, or null when a card is gone.
   */
  function link(editor, from, to, op) {
    const a = editor.getShapePageBounds(from);
    const b = editor.getShapePageBounds(to);
    if (!a || !b) return null;
    const start = { x: a.maxX, y: a.center.y };
    const end = { x: b.minX, y: b.center.y };
    const id = deps.createShapeId();
    editor.createShape({
      id, type: 'arrow', x: start.x, y: start.y, meta: { timmyOperation: op },
      props: { kind: 'elbow', start: { x: 0, y: 0 }, end: { x: end.x - start.x, y: end.y - start.y }, dash: 'solid', size: 's' },
    });
    editor.createBindings([
      { type: 'arrow', fromId: id, toId: from, props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false } },
      { type: 'arrow', fromId: id, toId: to, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false } },
    ]);
    return id;
  }

  /**
   * R4 (H100): "Place this operation": operation `opId`'s workflow, flow and result cards, as the reading `answer` lists them
   * (its cards in the order they ran), as drawn cards on this page: left to right in that order, each linked to the next by an
   * arrow bound to both. The page keeps what it placed for the operation in its meta (PLACEMENTS), so a second press adds only
   * the cards that ran since (after the rightmost card of the operation, linked to the one before) and says so; a card the
   * person moved or resized stays where and as they left it, a card or arrow they deleted is not placed again, and nothing is
   * written over. One press is one step of tldraw's undo. Returns what it did, with the words the panel says.
   */
  async function placeOperation(opId, answer, editor = deps.editor()) {
    if (!answer || !answer.project) throw new Error((answer && answer.message) || 'No project is named to this canvas.');
    const op = (answer.operations || []).find((o) => o && o.id === opId);
    if (!op) throw new Error(`No operation ${JSON.stringify(String(opId)).slice(0, 40)} among ${answer.project.name}'s cards now.`);
    const cards = new Map((answer.cards || []).map((c) => [c.id, c]));
    const page = editor.getCurrentPage();
    const key = placementKey(answer.project.id, op.id);
    const held = page.meta && page.meta[PLACEMENTS] && typeof page.meta[PLACEMENTS] === 'object' && !Array.isArray(page.meta[PLACEMENTS]) ? page.meta[PLACEMENTS] : {};
    const kept = readPlacement(Object.prototype.hasOwnProperty.call(held, key) ? held[key] : null);
    const plan = placementPlan(op, cards, (kind) => drawnType(kind) !== null, kept, (id) => !!editor.getShape(id));
    if (!plan.order.length) throw new Error(`Operation ${op.id} has no card that draws: ${plan.skipped.length ? 'its records cannot be read as cards' : 'none of its cards is listed now'}.`);
    const widthOf = (id) => WIDTH[drawnType(cards.get(id).kind)];
    // Where the new cards go: after the rightmost card of the operation still on the canvas; else below everything on this
    // page; else where the panel's cards go (beside the panel).
    const present = plan.already.map((a) => editor.getShapePageBounds(a.shape)).filter(Boolean);
    let start;
    if (present.length) {
      const right = present.reduce((x, y) => (y.maxX > x.maxX ? y : x));
      start = { x: right.maxX + ROW_GAP, y: right.minY };
    } else {
      const all = editor.getCurrentPageShapes().map((s) => editor.getShapePageBounds(s.id)).filter(Boolean);
      const width = plan.place.reduce((w, id) => w + widthOf(id) + ROW_GAP, -ROW_GAP);
      start = all.length ? { x: Math.min(...all.map((b) => b.minX)), y: Math.max(...all.map((b) => b.maxY)) + 96 } : deps.place(editor, { w: Math.max(1, width), h: 160 });
    }
    editor.markHistoryStoppingPoint(`timmy place operation ${op.id}`);
    const made = rowLayout(plan.place, start, widthOf).map((at) => {
      const card = cards.get(at.card);
      const type = drawnType(card.kind);
      const shape = deps.createShapeId();
      editor.createShape({ id: shape, type: CARD_SHAPES[type], x: at.x, y: at.y, props: propsFor(card, answer, type), meta: { timmyOperation: op.id } });
      return { card: at.card, shape };
    });
    const shapeOf = new Map([...plan.already.map((a) => [a.card, a.shape]), ...made.map((m) => [m.card, m.shape])]);
    const drawn = [];
    for (const l of plan.links) {
      const from = shapeOf.get(l.from);
      const to = shapeOf.get(l.to);
      if (!from || !to || !editor.getShape(from) || !editor.getShape(to)) continue;
      const arrow = link(editor, from, to, op.id);
      if (arrow) drawn.push({ from: l.from, to: l.to, arrow });
    }
    const now = editor.getPage(page.id) ?? page;
    const record = { v: 1, project: answer.project.name, placed: [...kept.placed, ...made], links: [...kept.links, ...drawn], at: new Date().toISOString() };
    editor.updatePage({ id: page.id, meta: { ...(now.meta || {}), [PLACEMENTS]: { ...held, [key]: record } } });
    const shown = [...shapeOf.values()].filter((id) => editor.getShape(id) && editor.getAncestorPageId(id) === page.id);
    if (made.length) editor.select(...made.map((m) => m.shape));
    try { deps.reveal(editor, shown); } catch { /* showing them is a courtesy */ }
    await revealSized(editor, shown);
    const words = placementWords(op.id, { ...plan, drawn: drawn.length });
    return { operation: op.id, placed: made, already: plan.already, deleted: plan.deleted, skipped: plan.skipped, arrows: drawn, cut: plan.cut, linked: plan.linked, words };
  }

  // ── drawing ──
  const handled = (e) => { const ed = deps.editor(); if (ed) ed.markEventAsHandled(e); };
  const span = (cls, text, extra = {}) => h('span', { className: cls, ...extra }, text);
  const cmd = (text) => h('code', { className: 'tc-cmd', title: 'Type this in Timmy' }, text);
  const words = (cls, text) => (one(text) ? h('p', { className: cls }, text) : null);
  const toneClass = (tone) => (tone === 'failed' ? 'tc-bad' : tone === 'attention' ? 'tc-warn' : '');

  /**
   * R4 (H100): the line naming the card's operation (from its detail as read now, or as last read), the id as text a person
   * can select and type in Timmy (/op <id>); null when the card has no reading of it (never read, or its detail withheld).
   */
  function opFace(op) {
    if (!op || typeof op !== 'object') return null;
    if (typeof op.id === 'string' && op.id) return h('p', { className: 'tc-op' }, 'operation ', h('code', { className: 'tc-op-id' }, op.id));
    return h('p', { className: 'tc-op tc-op-none' }, operationLine(null, op.from));
  }

  /** R4 (H100): the card's operation in Details: where it was read (or why none), its request and state as its record says, and /op. */
  function opRows(op) {
    if (!op || typeof op !== 'object') return null;
    if (!(typeof op.id === 'string' && op.id)) return dl([['operation', `none: ${one(op.from) || 'its record names none'}`]]);
    return dl([
      ['operation', `${op.id}, as ${one(op.from) || 'its record'} names it`],
      ['its request', op.request ? op.request : 'no record of it in this project'],
      op.state ? ['its state', `${op.state}, as its record says`] : null,
      ['in Timmy', cmd(`/op ${op.id}`)],
    ]);
  }

  /** The card's frame: its head (title, badge), its mode in words, its body, Details, the last answer and its reading. */
  function Frame({ shape, type, mode, children, details, follows, answer, readAt, op }) {
    const ref = React.useRef(null);
    const p = shape.props;
    // The shape's height follows its content (the width is the person's): written without an undo step.
    React.useLayoutEffect(() => {
      const el = ref.current;
      const editor = deps.editor();
      if (!el || !editor) return undefined;
      const fit = () => {
        const want = Math.max(80, Math.ceil(el.scrollHeight) + 2);
        const now = editor.getShape(shape.id);
        if (now && Math.abs(now.props.h - want) > 1) editor.run(() => editor.updateShape({ id: shape.id, type: shape.type, props: { h: want } }), { history: 'ignore' });
      };
      fit();
      if (typeof ResizeObserver === 'undefined') return undefined;
      const ro = new ResizeObserver(fit);
      ro.observe(el);
      return () => ro.disconnect();
    }, [shape.id, shape.type]);
    const toggle = () => { const ed = deps.editor(); if (ed) ed.updateShape({ id: shape.id, type: shape.type, props: { open: !p.open } }); };
    const busy = answer && answer.busy;
    const said = answer && answer.answer;
    // The answer's first lines on the card; all of it under Details.
    const lines = said ? said.text.split('\n') : [];
    const shown = lines.length > 8 ? `${lines.slice(0, 8).join('\n')}\n… ${lines.length - 8} more lines under Details` : lines.join('\n');
    return h(HTMLContainer, { className: `tc tc-${type}`, 'data-timmy-card': shape.id, style: { width: p.w, height: p.h, pointerEvents: 'all' } },
      h('div', { ref, className: 'tc-inner', role: 'group', 'aria-label': `${type} card: ${p.title}` },
        h('div', { className: 'tc-head' },
          h('strong', { className: 'tc-title' }, p.title || p.card),
          span(`tc-badge tc-${mode.badge}`, mode.badge)),
        h('p', { className: `tc-mode${mode.executable ? ' tc-mode-on' : ''}` }, mode.words),
        // R4 (H100): the operation its record names (none on a withheld card: its words say how to read it)
        mode.withheld ? null : opFace(op),
        ...React.Children.toArray(children),
        busy ? h('p', { className: 'tc-answer', role: 'status' }, 'Sent to Timmy; waiting for its answer…') : null,
        said ? h('pre', { className: `tc-answer${said.ok ? '' : ' tc-bad'}`, role: 'status' }, shown) : null,
        h('div', { className: 'tc-foot' },
          h('button', { type: 'button', className: 'tc-toggle', 'aria-expanded': String(!!p.open), onPointerDown: handled, onClick: toggle }, p.open ? 'Hide details' : 'Details'),
          span('tc-read', mode.withheld ? 'its detail withheld here' : follows ? `read from Timmy's records at ${clock(readAt)}` : p.readAt ? `as last read at ${clock(p.readAt)}` : 'never read', { title: follows ? readAt : p.readAt })),
        p.open ? h('div', { className: 'tc-details' }, ...React.Children.toArray([mode.withheld ? null : opRows(op), ...[details].flat()]), said && lines.length > 8 ? h('pre', { className: 'tc-answer' }, said.text) : null) : null));
  }

  /** The values of `rows` as a definition list (technical detail). */
  const dl = (rows) => h('dl', { className: 'tc-dl' }, ...rows.filter(Boolean).flatMap(([k, v]) => [h('dt', { key: `k${k}` }, k), h('dd', { key: `v${k}` }, v)]));

  function useCard(shape, type) {
    const now = useValue('timmy cards: reading', () => live.get().answer, []);
    const own = useValue('timmy cards: this card\'s action', () => acts.get()[shape.id] ?? null, [shape.id]);
    const sess = useValue('timmy cards: session', () => session.get(), []);
    const p = shape.props;
    const mode = cardMode(type, p, now, sess.state === 'ok' && token !== null);
    const card = mode.follows ? (now.cards || []).find((c) => c.id === p.card) : null;
    // R4 (H83): a withheld card has no detail here (only the words and commands its marker holds)
    const detail = mode.withheld ? null : (card && card.detail) || p.data;
    return { now, own, mode, card, detail, readAt: now ? now.madeAt : p.readAt };
  }

  /** R4 (H83): the body of a card whose kept detail is withheld here: the commands that read it, typed in Timmy. */
  function withheldBody(p) {
    const w = withheldData(p.data);
    const commands = w && SAFE.isArray(w.commands) ? w.commands.filter((c) => typeof c === 'string').slice(0, 3) : ['/canvas open'];
    return h('div', { className: 'tc-acts tc-withheld' }, ...commands.map((c, i) => h('code', { key: `w${i}`, className: 'tc-cmd', title: 'Type this in Timmy' }, c)));
  }

  /**
   * R4 (H83): a highlight of the project, fetched with this page's session and shown from memory; the object URL is let go when
   * the card stops showing it.
   */
  function Highlight({ path }) {
    const [src, setSrc] = React.useState(null);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
      let made = null;
      let gone = false;
      image(path).then((url) => {
        if (gone) { forget(url); return; }
        made = url;
        if (url) setSrc(url); else setFailed(true);
      }, () => { if (!gone) setFailed(true); });
      return () => { gone = true; forget(made); };
    }, [path]);
    if (src) return h('img', { src, alt: `highlight ${path}`, title: path, draggable: false, 'data-tc-image': path });
    return span('tc-note', failed ? `highlight ${path}: not read now` : `highlight ${path}: reading…`);
  }

  function WorkflowCard({ shape }) {
    const { own, mode, detail, readAt } = useCard(shape, 'workflow');
    const p = shape.props;
    const d = detail && detail.type === 'workflow' ? detail : null;
    const busy = !!(own && own.busy);
    const blocks = d ? d.blocks : [];
    // R4 (H81): each Run button carries its own recorded action (actRef): the block it was drawn for, never one read at the click
    // R4 (H88): a document that names two blocks alike runs none of them (its notRunnable words say so once, above them)
    const runOf = (b) => (mode.executable && d.runnable && b.runnable
      ? h('button', { type: 'button', className: 'tc-btn', 'data-tc-act': 'run', 'data-tc-block': b.name, disabled: busy, ref: actRef(shape, 'workflow', runAct(d, b.name), !busy), onPointerDown: handled, title: `Sends /run ${d.doc} ${b.name} to Timmy (Run up to here)` }, 'Run up to here')
      : d.runnable && b.runnable ? cmd(`/run ${d.doc} ${b.name}`) : one(d.notRunnable) ? null : span('tc-note', '/run cannot name this block as one word'));
    const last = d && d.last;
    return h(Frame, {
      shape, type: 'workflow', mode, follows: mode.follows, answer: own, readAt, op: d ? d.operation : undefined,
      details: d ? [
        dl([['document', d.doc], ['sha256', d.sha256 || 'not hashed'], ['card', p.card], ['project', `${p.project} (${p.projectId})`],
          last ? ['newest run', `job ${last.job}${last.predicted ? ` · prediction receipt ${last.predicted}` : ''}${last.receipt ? ` · outcome receipt ${last.receipt}` : ''}`] : null,
          last && last.note ? ['its record says', last.note] : null, last && last.error ? ['error', last.error] : null]),
        ...blocks.map((b) => h('div', { key: `c${b.key}`, className: 'tc-block-cmd' }, span('tc-k', `${b.name}${b.needs.length ? ` (needs ${b.needs.join(', ')})` : ''}`), ...b.command.map((l, i) => h('code', { key: i }, l)))),
        ...(last ? last.outputs.map((o) => h('div', { key: `o${o.path}`, className: 'tc-out' }, span('tc-path', o.path), ' ', span('tc-note', o.now))) : []),
        last && last.more ? words('tc-note', `${last.more} more files`) : null,
      ] : words('tc-note', mode.withheld ? 'Its blocks and their commands are withheld here.' : 'No reading of this document yet.'),
    },
    d && one(d.notRunnable) ? h('p', { className: 'tc-note tc-warn tc-twice' }, d.notRunnable) : null,
    d ? h('ol', { className: 'tc-blocks' }, ...blocks.map((b) => h('li', { key: b.key, className: `tc-block tc-w-${String(b.word).replace(/[^a-z]/g, '')}` },
      span('tc-glyph', b.glyph, { 'aria-hidden': 'true' }), ' ', span('tc-name', b.name), ' ', span(`tc-word ${b.word === 'failed' || b.word === 'interrupted' ? 'tc-bad' : ''}`, b.word),
      b.detail ? span('tc-note', ` · ${b.detail}`) : null, h('div', { className: 'tc-acts' }, runOf(b))))) : mode.withheld ? withheldBody(p) : words('tc-note', p.command),
    last ? h('p', { className: 'tc-last' }, `Newest run (${last.target}): `, span(last.word === 'failed' || last.word === 'interrupted' ? 'tc-bad' : '', last.word),
      `${last.met === true ? ', its prediction met' : last.met === false ? ', its prediction not met' : ''}${last.took ? ` · ${last.took}` : ''}${last.receipt ? ` · receipt ${last.receipt}` : ''}`) : d ? words('tc-note', 'Not run yet.') : null);
  }

  function ParamsCard({ shape }) {
    const { own, mode, detail, readAt } = useCard(shape, 'params');
    const p = shape.props;
    const d = detail && detail.type === 'params' ? detail : null;
    // Values typed here (by name), and the reading they were typed over: Save sends that reading's sha256 as its base.
    const [typed, setTyped] = React.useState({});
    const [over, setOver] = React.useState(null);
    const saved = own && own.saved;
    React.useEffect(() => { if (saved) { setTyped({}); setOver(null); } }, [saved]);
    const view = over || d;
    const editable = !!(mode.executable && d && d.save.offered);
    const dirty = Object.keys(typed).some((n) => { const v = (view.values || []).find((x) => x.name === n); return v && typed[n].trim() !== shownValue(v.value); });
    const busy = !!(own && own.busy);
    const field = (v) => {
      if (!editable) return span('tc-value', `${shownValue(v.value)}${v.unit ? ` ${v.unit}` : ''}`);
      const value = Object.prototype.hasOwnProperty.call(typed, v.name) ? typed[v.name] : shownValue(v.value);
      const onChange = (e) => { if (!over) setOver(d); setTyped({ ...typed, [v.name]: e.target.value }); };
      const common = { className: 'tc-input', 'data-tc-param': v.name, value, onChange, onPointerDown: handled, 'aria-label': `${v.name}${v.unit ? ` in ${v.unit}` : ''}` };
      return v.kind === 'boolean'
        ? h('select', common, h('option', { value: 'true' }, 'true'), h('option', { value: 'false' }, 'false'))
        : h('input', { ...common, type: 'text', inputMode: v.kind === 'number' ? 'decimal' : 'text', spellCheck: false, size: 8 });
    };
    // Each value with its unit beside it, and its meaning and range under it.
    const rows = view ? (view.values || []).flatMap((v) => [
      h('tr', { key: `v${v.name}` }, h('th', { scope: 'row' }, v.name), h('td', null, field(v), editable && v.unit ? span('tc-note', ` ${v.unit}`) : null, v.default !== undefined ? span('tc-note', ` (default ${shownValue(v.default)})`) : null)),
      ...(v.help ? [h('tr', { key: `h${v.name}`, className: 'tc-help-row' }, h('td', null), h('td', { className: 'tc-help' }, v.help))] : []),
    ]) : [];
    const build = d && d.build;
    const stateWords = !d ? p.command : d.state === 'ok' ? `saved in ${d.file}` : d.state === 'none' ? `no ${d.file} yet: ${d.engine === 'tray' ? 'the recipe\'s own defaults' : 'the model\'s own values'}` : `not usable: ${d.error}`;
    return h(Frame, {
      shape, type: 'params', mode, follows: mode.follows, answer: own, readAt, op: d ? d.operation : undefined,
      details: d ? [dl([['file', d.file], ['sha256', d.base || 'no file'], ['card', p.card], ['project', `${p.project} (${p.projectId})`],
        d.fixed ? ['fixed', `${d.fixed}${d.units ? ` (${d.units})` : ''}`] : null, ['run it', d.run], ['saving', d.save.offered ? 'through the live board\'s save path: checked by the recipe\'s rules, refused while a flow runs here, the previous version kept, an edit receipt' : d.save.why],
        over ? ['editing over', `sha256 ${String(over.base).slice(0, 12)}: a save is refused if the file changed since`] : null]),
      ...(build ? [dl([['newest build', `${build.title} · ${build.word}`], ...build.facts.map((f) => [f.label, `${f.value} (${f.how})`]), ...build.receipts.map((r) => ['receipt', r]), ...build.files.map((f) => [f.note || 'file', f.path])])] : []),
      ] : words('tc-note', mode.withheld ? 'Its values are withheld here.' : 'No reading of this file yet.'),
    },
    mode.withheld ? withheldBody(p) : words('tc-state', stateWords),
    view ? h('form', { className: 'tc-form', onSubmit: (e) => e.preventDefault() },
      h('table', { className: 'tc-table' }, h('tbody', null, ...rows)),
      d && d.more ? words('tc-note', `${d.more} more values: /open ${d.file}`) : null) : null,
    d ? h('div', { className: 'tc-acts' },
      // R4 (H81): Save sends the values typed into this card's own state and the sha256 of the reading they were typed over,
      // recorded as the button is drawn (actRef): the fields' text on the page is never read when the click comes
      editable ? h('button', { type: 'button', className: 'tc-btn', 'data-tc-act': 'save', disabled: busy || !(dirty || d.state === 'unusable'), ref: actRef(shape, 'params', saveAct(view, typed, (over ? over.base : d.base) ?? null), !(busy || !(dirty || d.state === 'unusable'))), onPointerDown: handled, title: 'Sends the live board\'s parameter save to Timmy' }, 'Save') : null,
      editable && dirty ? h('button', { type: 'button', className: 'tc-btn tc-quiet', onPointerDown: handled, onClick: () => { setTyped({}); setOver(null); } }, 'Discard') : null,
      mode.executable && d.rebuild ? h('button', { type: 'button', className: 'tc-btn', 'data-tc-act': 'rebuild', disabled: busy || dirty, ref: actRef(shape, 'params', rebuildAct(d), !(busy || dirty)), onPointerDown: handled, title: dirty ? 'Save first: Rebuild uses the saved file' : `Sends Rebuild (${d.run}) to Timmy` }, 'Rebuild') : null,
      !mode.executable || !d.save.offered ? cmd(d.run) : null,
      !editable && d.state !== 'none' ? cmd(`/open ${d.file}`) : null,
      mode.executable && !d.save.offered ? words('tc-note', d.save.why) : null) : null,
    build ? h('div', { className: 'tc-build' },
      h('p', null, 'Newest build: ', span(toneClass(build.tone), build.word), build.detail ? span('tc-note', ` · ${build.detail}`) : null),
      ...build.facts.slice(0, 3).map((f) => h('p', { key: f.label, className: 'tc-fact' }, `${f.label} ${f.value}`, span('tc-note', ` · ${f.how}`)))) : null,
    d && d.notice ? h('p', { className: 'tc-notice' }, d.notice) : null);
  }

  function ResultCard({ shape }) {
    const { own, mode, detail, readAt } = useCard(shape, 'result');
    const p = shape.props;
    const d = detail && detail.type === 'result' ? detail : null;
    return h(Frame, {
      shape, type: 'result', mode, follows: mode.follows, answer: own, readAt, op: d ? d.operation : undefined,
      details: d ? [dl([['card', p.card], ['project', `${p.project} (${p.projectId})`], ['check', d.check.words], d.check.receipt ? ['receipt', d.check.receipt] : null,
        d.started ? ['started', d.started] : null, d.ended ? ['ended', d.ended] : null, ['command', p.command]]),
      ...d.outputs.map((o) => h('div', { key: `s${o.path}`, className: 'tc-out' }, span('tc-path', o.path), ' ', span('tc-note', `${o.sha256 ? `sha256 ${o.sha256}` : 'no sha256 recorded'}${o.bytes !== null ? ` · ${o.bytes} bytes` : ''}`))),
      ...d.lines.map((l, i) => h('p', { key: `l${i}`, className: 'tc-note' }, l)),
      ] : words('tc-note', mode.withheld ? 'Its record\'s facts are withheld here.' : 'No reading of this record yet.'),
    },
    d ? h('p', { className: 'tc-verdict' }, span(toneClass(d.verdict.tone), d.verdict.words)) : mode.withheld ? withheldBody(p) : words('tc-note', p.command),
    d ? h('p', { className: `tc-check tc-check-${d.check.status}` }, span('tc-k', CHECK_WORD[d.check.status] ?? d.check.status), ` · ${d.check.words}`) : null,
    d && d.facts.length ? h('dl', { className: 'tc-dl' }, ...d.facts.flatMap((f, i) => [h('dt', { key: `k${i}` }, f.label), h('dd', { key: `v${i}` }, f.value, ' ', span('tc-note', f.how))])) : null,
    // R4 (H83): a highlight is read with this page's session and shown from memory (Highlight), only while the card is followed
    d && d.images.length ? h('div', { className: 'tc-images' }, ...d.images.map((im) => (mode.follows
      ? h(Highlight, { key: im.path, path: im.path })
      : span('tc-note', `highlight ${im.path}: shown while the canvas follows ${p.project}`, { key: im.path })))) : null,
    d && d.outputs.length ? h('ul', { className: 'tc-outs' }, ...d.outputs.map((o) => h('li', { key: o.path }, span('tc-path', o.path), ' ', span('tc-note', `${o.sha256 ? `sha256 ${o.sha256.slice(0, 12)} · ` : ''}${o.now}`)))) : null,
    d && d.notice ? h('p', { className: 'tc-notice' }, d.notice) : null,
    h('div', { className: 'tc-acts' }, cmd(p.command)));
  }

  const props = {
    w: T.number, h: T.number, card: T.string, kind: T.string, projectId: T.string, project: T.string, title: T.string, command: T.string,
    data: T.jsonValue, readAt: T.string, open: T.boolean, gone: T.boolean,
  };
  const defaults = (type) => ({ w: WIDTH[type], h: 160, card: '', kind: '', projectId: '', project: '', title: '', command: '', data: null, readAt: '', open: false, gone: false });
  const make = (type, Component) => {
    class CardUtil extends BaseBoxShapeUtil {
      static type = CARD_SHAPES[type];
      static props = props;
      getDefaultProps() { return defaults(type); }
      hideRotateHandle() { return true; }
      canEdit() { return false; }
      // The width is the person's; the height follows the content.
      onResize(shape, info) { const next = resizeBox(shape, info); return { ...next, y: shape.y, props: { ...next.props, h: shape.props.h } }; }
      getText(shape) { return `${shape.props.title}\n${shape.props.command}`; }
      component(shape) { return h(Component, { shape }); }
      getIndicatorPath(shape) { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path; }
    }
    return CardUtil;
  };
  const utils = [make('workflow', WorkflowCard), make('params', ParamsCard), make('result', ResultCard)];
  return {
    utils, startSession, onAnswer, wantsFast, place,
    // R4 (H100): an operation's cards at once, left to right in the order they ran, linked
    placeOperation,
    // R4 (H81): the panel's reading of the project (with the detail only through this page's session)
    read,
    // R4 (H83): the canvas, its settings, its jobs and the bridge, each with this page's session (never handed out)
    hasSession, config, loadDocument, saveDocument, jobs, bridgeSocket, sessionEnded,
    setPoll: (f) => { poll = f; },
    /** R4 (H88): told when the session's state changes (the panel's line follows it). */
    setSessionListener: (f) => { onSession = typeof f === 'function' ? f : () => {}; },
    /** For the tests and the status line: the session in words (never the token). */
    session: () => session.get(),
  };
}
