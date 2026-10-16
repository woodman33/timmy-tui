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
// Nothing here imports anything but ./operations.js (pure rules) and ./when.js (the one time format): canvas.js hands in React
// and tldraw's classes, so the rules below run in Node's tests too.
import { isTimmyArrow, OPERATION_ID, operationLine, placementKey, placementPlan, placementWords, PLACEMENTS, readPlacement, removalWords, ROW_GAP, rowLayout } from './operations.js';
import { clockOf } from './when.js';

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
  // R5 (H137): a highlight's answer is an image, or (a paused session) the server's words as JSON
  blobType: descriptor(G.Blob && G.Blob.prototype, 'type')?.get ?? null,
  blobText: G.Blob ? G.Blob.prototype.text : null,
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
export function cardMode(type, props, answer, session, meta = null) {
  const diagram = (words, follows = false) => ({ executable: false, badge: 'diagram', words, follows });
  const name = props.project || 'its project';
  // R5 (H133): a card Timmy proposed as a draft acts only once a person accepts it (./drafts.js; the panel's Drafts)
  if (meta && meta.timmyDraft && typeof meta.timmyDraft === 'object') return { ...diagram('A draft proposed by Timmy: nothing on it acts until you accept it in Timmy\'s panel (Drafts).'), draft: true };
  // R4 (H83): a card of another project, its kept detail withheld from this page: it says so, and how to read it
  const withheld = withheldData(props.data);
  if (withheld) return { ...diagram(one(withheld.words)), withheld: true };
  if (!answer) return diagram('Not read from Timmy yet.');
  // R4 (H83): the project was not read: this page's session does not count now (it ended, or the canvas shows another project)
  if (answer.refused) return diagram(`Not followed now: ${one(answer.refused)} Shown as last read.`);
  if (!answer.project) return diagram(`Not followed now: no project is named to this canvas (in Timmy: /canvas open). Shown as last read.`);
  // R4 (H109): a board pinned to a project reads that project: a card of another project on it is not followed there
  if (answer.project.id !== props.projectId) {
    return diagram(answer.pinned ? `Not followed on this board: it is pinned to ${answer.project.name}, not ${name}. Shown as last read.` : `Not followed now: the canvas shows ${answer.project.name}, not ${name}. Shown as last read.`);
  }
  const card = (answer.cards || []).find((c) => c.id === props.card);
  if (!card) return diagram(`Its record is not in ${name} now: shown as last read.`);
  // R4 (H81): the detail (each block's command, each value) is read only with a session that counts: without one the card
  // is shown as last read, and says why
  if (answer.detail === false) return diagram(`${one(answer.detailWhy) || 'Its detail was not read: this page has no session that reads it.'} Shown as last read.`);
  if (type === 'result') return diagram('A diagram of its record, read from Timmy now: nothing runs from this card.', true);
  if (!answer.actions || answer.actions.holder !== true) return diagram(one(answer.actions?.words) || `No Timmy REPL takes ${name}'s actions now.`, true);
  if (!session) return diagram('Read from Timmy now, but this page cannot act: it was not opened by /canvas open in Timmy, or it was reloaded since. Type the command in Timmy, or /canvas open there.', true);
  return { executable: true, badge: 'executable', words: `Executable: its buttons are sent to the Timmy that holds ${name} (a REPL, or the Workbench), which runs them as the live board's own actions.`, follows: true };
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

/** R4 (H109): the operation a drawn card was placed for ("Place this operation" names it in the shape's meta), or null. */
export const boundOperation = (shape) => {
  const op = shape && shape.meta && typeof shape.meta === 'object' ? shape.meta.timmyOperation : undefined;
  return typeof op === 'string' && OPERATION_ID.test(op) ? op : null;
};

/**
 * R4 (H109; r25 D9 c): a parameter card placed for operation `op` keeps, beside the file as it is now (`detail`), what that
 * operation used of the file (`used`), as the reading lists it for the operation (src/studio/used-values.ts: from its flow
 * record, or the bytes a receipt of it names); when the reading lists the operation and none of its records names the file, that
 * is unknown, and why; when the reading does not list the operation, what this card last read (`prev`), said as last read; with
 * neither, unknown, and why. Never today's values in their place. A workflow card keeps its operation's own run (boundRun);
 * any other card's detail is returned as it is.
 */
export function boundDetail(detail, op, answer, prev) {
  if (!detail || typeof op !== 'string' || !OPERATION_ID.test(op)) return detail ?? null;
  if (detail.type === 'workflow') return boundRun(detail, op, answer, prev);
  if (detail.type !== 'params') return detail;
  const listed = (answer && Array.isArray(answer.operations) ? answer.operations : []).find((o) => o && o.id === op);
  const read = listed && Array.isArray(listed.used) ? listed.used.find((u) => u && u.operation === op && u.file === detail.file) : undefined;
  const last = prev && prev.used && prev.used.operation === op && prev.used.file === detail.file ? prev.used : null;
  const none = (from) => ({ operation: op, file: detail.file, state: 'unknown', values: [], sha256: null, from, verified: false, build: null });
  let used;
  if (read) used = read;
  else if (listed) used = none(`no record of operation ${op} names ${detail.file}: no flow of it changed the file, and no receipt of it names the file's bytes`);
  else if (last) used = last.asLastRead ? last : { ...last, asLastRead: true };
  else used = none(`operation ${op} is not among the operations this reading lists, and this card holds no earlier reading of what it used`);
  return { ...detail, used };
}

/** R4 (H109): a run as a workflow card keeps it: its newest run (`last`) and its blocks' states, nothing else of the document. */
const runOfDetail = (op, doc, last, blocks) => ({
  operation: op, doc, state: 'recorded', last,
  blocks: (Array.isArray(blocks) ? blocks : []).map((b) => ({ name: String(b.name), word: String(b.word), glyph: String(b.glyph ?? ''), detail: String(b.detail ?? '') })),
});

/**
 * R4 (H109; the operator's "Bind workflow/result nodes to real operation and artifact IDs"): a workflow card placed for
 * operation `op` keeps that operation's own run of its document (`ran`) beside the document's newest run (`detail`, as read
 * now): none when the newest run is the operation's own (the card's detail is then its run); the reading's run of it for the
 * operation (src/studio/operation-runs.ts); unknown, and why, when the reading read the operation's runs and none ran the
 * document; else what this card last read (`prev`: its run kept before, or its detail when that was the operation's own run),
 * said as last read; with neither, unknown, and why. Never the newest run in its place.
 */
export function boundRun(detail, op, answer, prev) {
  if (detail.operation && detail.operation.id === op) return detail;
  const listed = (answer && Array.isArray(answer.operations) ? answer.operations : []).find((o) => o && o.id === op);
  const read = listed && Array.isArray(listed.ran) ? listed.ran.find((r) => r && r.doc === detail.doc && r.last) : undefined;
  const unknown = (why) => ({ operation: op, doc: detail.doc, state: 'unknown', last: null, blocks: [], why });
  let ran;
  if (read) ran = runOfDetail(op, detail.doc, read.last, read.blocks);
  else if (listed && Array.isArray(listed.ran)) ran = unknown(`no job record Timmy keeps names operation ${op} running ${detail.doc}`);
  else {
    const same = prev && prev.type === 'workflow' && prev.doc === detail.doc ? prev : null;
    const kept = same && same.ran && same.ran.operation === op && same.ran.state === 'recorded' ? same.ran
      : same && same.operation && same.operation.id === op && same.last ? runOfDetail(op, detail.doc, same.last, same.blocks) : null;
    ran = kept ? (kept.asLastRead ? kept : { ...kept, asLastRead: true })
      : unknown(listed ? `the runs of operation ${op} were not read in this reading, and this card holds no earlier reading of its run`
        : `operation ${op} is not among the operations this reading lists, and this card holds no earlier reading of its run`);
  }
  return { ...detail, ran };
}

/**
 * R4 (H109): one value as used beside the file now: what to say after it (null when the file holds the same value now). `now`
 * the parameter card's detail as read now (its values are the file's only when its state is 'ok').
 */
export function nowBeside(name, used, now) {
  if (!now || now.state !== 'ok') return null;
  const v = (now.values || []).find((x) => x.name === name);
  if (!v) return `not in ${now.file} now`;
  return shownValue(v.value) === shownValue(used) ? null : `now ${shownValue(v.value)}${v.unit ? ` ${v.unit}` : ''} in ${now.file}`;
}

/** Whether a card's detail says a job of it still runs (the page then reads the project more often). */
export function stillRunning(detail) {
  if (!detail) return false;
  if (detail.type === 'workflow') return detail.running === true;
  if (detail.type === 'params') return !!detail.build && detail.build.tone === 'running';
  return detail.verdict && detail.verdict.tone === 'running';
}

/** A time as a card says it: the clock time (the full time is its tooltip). R5 (H137; QA defect 6): in the one format. */
function clock(iso) {
  return clockOf(iso) || String(iso || '');
}

// ── the shapes and their runtime (the browser only) ────────────────────────────

/**
 * The three shape utils and the runtime that feeds and acts for them. `deps`: React, BaseBoxShapeUtil, HTMLContainer, T,
 * atom, useValue, resizeBox (from tldraw); createShapeId; editor() (the live editor); place(editor, size) → where a new card goes;
 * reveal(editor, ids); grant (the one-time code this page was opened with, or null). R4 (H109): say(text) writes the panel's
 * band (what Timmy did on its own, such as the arrows it removed with a deleted card); runDetail(op, projectId), optional, shows
 * an operation's run detail in the side panel (a card's Run detail).
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
   * R5 (H137): the server's answer to a reading this page makes by itself, when its session is paused (another project, or another
   * REPL, holds the canvas now: src/studio/session-pause.ts): a plain 200 that says why (`session`: project or holder), with
   * nothing of the project, so the browser logs no failed request. It pauses the session as the 401 it replaced did.
   */
  const pausedAnswer = (r) => !!(r && r.ok && r.body && r.body.ok === false && (r.body.session === 'project' || r.body.session === 'holder'));

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
    } else if (r && (r.status === 401 || pausedAnswer(r)) && (said.session === 'project' || said.session === 'holder')) notNow(why); // R4 (H88)
    return why;
  }

  /** R4 (H83): a reading this page was refused: no project, the refusal in words (the panel and the cards say it). */
  const refusedReading = (why) => ({ ok: false, refused: why, message: why, project: null, board: null, cards: [], notes: [], detail: false, detailWhy: why, madeAt: new Date().toISOString() });

  /**
   * R4 (H81): one reading of the project for the panel and the cards: GET /api/project?detail=1 (each card's detail) with this
   * page's session. R4 (H83): the card list is read with a session too, so without one that counts now there is no reading:
   * the answer says why (`refused`). A session given for another project, or by another REPL, is asked again in 30 s.
   */
  async function read(pinned = null) {
    if (!token) return refusedReading(session.get().words);
    // R4 (H109): a board pinned to a project reads that project (GET /api/project?project=<id>), whatever the canvas shows
    if (typeof pinned === 'string' && /^[0-9a-f]{16}$/.test(pinned)) return readPinned(pinned);
    if (Date.now() < notFor.until) return refusedReading(notFor.why);
    const r = await request('/api/project?detail=1', 'GET', token);
    if (r.ok && r.body && r.body.ok === true) { notFor.until = 0; countsAgain(); return { ...r.body, detail: true }; }
    if (r.status !== 401 && !pausedAnswer(r)) throw new Error(`Timmy answered ${r.status} for the project`);
    const why = noted(r, 'Timmy did not let this page read the project.');
    if (token) {
      // given for another project, or by another REPL: asked again in 30 s
      notFor.until = Date.now() + 30_000;
      notFor.why = why;
    }
    return refusedReading(why);
  }

  /**
   * R4 (H109): the reading of a board pinned to project `id`: the server serves it read only while this page's session reaches
   * it (given for it, or followed to it since). A refusal for that project says why, and never pauses the session for the project
   * the canvas shows; a session that ended is let go, as everywhere.
   */
  async function readPinned(id) {
    const r = await request(`/api/project?detail=1&project=${id}`, 'GET', token);
    const said = r.body || {};
    if (r.ok && said.ok === true) {
      // the project the canvas shows is the board's: read as the canvas's own, so the session counts again
      if (said.pinned !== true) { notFor.until = 0; countsAgain(); }
      return { ...said, detail: true, pinned: true };
    }
    // R5 (H137): a paused session's refusal comes as a plain 200 (pausedAnswer), and reads as the 401 did
    const refusedNow = r.status === 401 || pausedAnswer(r);
    if (refusedNow && (said.session === 'expired' || said.session === 'unknown' || said.session === 'none' || said.pinned !== true)) {
      return { ...refusedReading(noted(r, 'Timmy did not let this page read the project.')), pinned: true, pinnedId: id };
    }
    if (refusedNow || r.status === 404) return { ...refusedReading(one(said.error) || `Timmy answered ${r.status} for this board's project.`), pinned: true, pinnedId: id };
    throw new Error(`Timmy answered ${r.status} for this board's project`);
  }

  // ── R4 (H83): the canvas itself, its settings, its jobs, a highlight and the bridge: each with this page's session ──
  /** Whether this page holds a session (it may still not count now: the server then refuses and says why). */
  const hasSession = () => token !== null;
  /** The page's settings: the license key comes only with the session. */
  async function config() { return request('/studio-config.json', 'GET', token); }
  /** R6 (H139): `?project=<id>` for a reading of the board of project `id` (the server refuses it when the canvas shows another). */
  const forProject = (path, id) => (typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) ? `${path}${path.includes('?') ? '&' : '?'}project=${id}` : path);
  /**
   * The canvas as saved, every card of another project with its kept detail withheld (the server's part). R6 (H139): the board of
   * the project named now (its answer says which: `project`), or of project `projectId` when given (refused, 409, when the canvas
   * shows another now).
   */
  async function loadDocument(projectId = null) {
    if (!token) return { status: 0, ok: false, body: null, why: session.get().words };
    const r = await request(forProject('/api/canvas/document', projectId), 'GET', token);
    if (r.status === 409) return { ...r, why: one(r.body && r.body.error) || 'The canvas shows another project now.' };
    return r.ok ? r : { ...r, why: noted(r, `Timmy answered ${r.status} for the saved canvas.`) };
  }
  /** Saves the canvas (`text`: the document as JSON text, written by canvas.js); as the page closes, `keepalive`. */
  async function saveDocument(text, keepalive = false) {
    if (!token) return { status: 0, ok: false, body: { ok: false, error: session.get().words } };
    const r = await request('/api/canvas/document', 'PUT', token, undefined, { raw: text, keepalive });
    if (r.status === 401) noted(r, 'Timmy refused this page\'s save.');
    return r;
  }
  /**
   * The canvas jobs, newest first; null when they cannot be read now (a session that does not count is asked again in 30 s). R6
   * (H139): of the board of project `projectId` (null as well when the canvas shows another project now).
   */
  async function jobs(projectId = null) {
    if (!token || Date.now() < notFor.until) return null;
    const r = await request(forProject('/api/canvas/jobs', projectId), 'GET', token, undefined, { array: true });
    // R5 (H137): a paused session's refusal is a plain 200 with no jobs (pausedAnswer)
    if (r.status === 401 || pausedAnswer(r)) {
      const why = noted(r, 'Timmy did not let this page read the canvas jobs.');
      if (token) { notFor.until = Date.now() + 30_000; notFor.why = why; }
    }
    return r.ok && SAFE.isArray(r.body) ? r.body : null;
  }
  /**
   * R5 (H133): the shared workspace frame of the project named now (GET /api/workspace), read with this page's session for the
   * strip above the canvas (./frame.js). Not asked without a session, or with one that does not count now (asked again once a
   * reading counts, and not sooner than 30 s), as the jobs are: the answer then says why, and no request is made.
   */
  async function workspace(projectId = null) {
    const notAsked = (why) => ({ status: 0, ok: false, body: { ok: false, error: why } });
    if (!token) return notAsked(session.get().words);
    if (Date.now() < notFor.until || session.get().state !== 'ok') return notAsked(notFor.why || session.get().words);
    // R6 (H139): the frame of the project whose board is on screen (refused, 409, when the canvas shows another now)
    const r = await request(forProject('/api/workspace', projectId), 'GET', token);
    // R5 (H137): a paused session's refusal is a plain 200 with no frame (pausedAnswer); the strip says why (./frame.js)
    if (r.status === 401 || pausedAnswer(r)) {
      const why = noted(r, 'Timmy did not let this page read the workspace.');
      if (token) { notFor.until = Date.now() + 30_000; notFor.why = why; }
    }
    return r;
  }
  /**
   * A highlight of the project, read with the session and shown from memory (an object URL); null when it is not read. R4 (H109):
   * of the card's own project (a board pinned to it reads it while the canvas shows another). R5 (H137): the shown project's are
   * not asked while the session is paused (the server would refuse them), and a paused session's refusal (a plain 200 with the
   * server's words as JSON, not an image) pauses it as a reading's does.
   */
  async function image(path, projectId = null) {
    if (!token || !SAFE.fetch || !SAFE.blob || !SAFE.objectURL) return null;
    const of = typeof projectId === 'string' && /^[0-9a-f]{16}$/.test(projectId) ? `&project=${projectId}` : '';
    if (!of && session.get().state !== 'ok') return null;
    const r = await SAFE.fetch(`/api/project/image?p=${SAFE.apply(SAFE.encode, G, [String(path)])}${of}`, requestInit('GET', token));
    if (!(SAFE.ok && SAFE.apply(SAFE.ok, r, []) === true)) return null;
    const b = await SAFE.apply(SAFE.blob, r, []);
    const type = SAFE.blobType ? String(SAFE.apply(SAFE.blobType, b, [])) : '';
    if (!/^image\//.test(type)) {
      let body = null;
      try { body = SAFE.parse(await SAFE.apply(SAFE.blobText, b, [])); } catch { body = null; }
      const answer = { status: 200, ok: true, body: body && typeof body === 'object' && !SAFE.isArray(body) ? body : null };
      if (!of && pausedAnswer(answer)) noted(answer, 'Timmy did not let this page read the highlight.');
      return null;
    }
    return SAFE.apply(SAFE.objectURL, SAFE.URL, [b]);
  }
  const forget = (url) => { if (url && SAFE.revokeURL) { try { SAFE.apply(SAFE.revokeURL, SAFE.URL, [url]); } catch { /* gone */ } } };
  /**
   * R4 (H109): operation `op`'s run detail (src/contracts/run-detail.ts), made by Timmy (never on this page) and read with this
   * page's session: GET /api/project/run-detail, of project `projectId` when given (a card's own project). { status, ok, body }.
   * A refusal for the card's own project when it is not the one shown (`other`) never pauses the session; one that ended lets it go.
   */
  async function runDetail(op, projectId = null) {
    if (!OPERATION_ID.test(String(op))) return { status: 400, ok: false, body: { ok: false, error: 'That is not an operation\'s id (o and 8 hex digits).' } };
    if (!token) return { status: 401, ok: false, body: { ok: false, error: session.get().words } };
    const of = typeof projectId === 'string' && /^[0-9a-f]{16}$/.test(projectId) ? `&project=${projectId}` : '';
    const r = await request(`/api/project/run-detail?op=${op}${of}`, 'GET', token);
    const said = r.body || {};
    if (r.status === 401 && (said.other !== true || said.session === 'expired' || said.session === 'unknown' || said.session === 'none')) noted(r, 'Timmy did not let this page read the run detail.');
    return r;
  }
  /**
   * R5 (H133): keeps this page's version of the canvas as a copy beside the canvas file (POST /api/canvas/document/copy), when a
   * newer version is on disk and this page may not save over it. `text`: the document as JSON text, written by canvas.js.
   */
  async function keepCopy(text) {
    if (!token) return { status: 0, ok: false, body: { ok: false, error: session.get().words } };
    const r = await request('/api/canvas/document/copy', 'POST', token, undefined, { raw: text });
    if (r.status === 401) noted(r, 'Timmy refused to keep this page\'s copy.');
    return r;
  }
  /**
   * R6 (H139): the saved board of project `projectId`, as the server's health says it (its revision and source revision, no content),
   * read with this page's session; refused (409) when the canvas shows another project now.
   */
  async function health(projectId) {
    if (!token) return { status: 0, ok: false, body: null };
    return request(forProject('/api/canvas/health', projectId), 'GET', token);
  }
  /**
   * R6 (H139): which project the canvas shows now (GET /api/project/active, with this page's session): { project, hidden } (hidden:
   * a project is named that this page's session does not count for, so it is not told which). Null when it cannot be read.
   */
  async function active() {
    if (!token) return null;
    const r = await request('/api/project/active', 'GET', token);
    if (!r.ok || !r.body || r.body.ok !== true) return null;
    return { project: r.body.project && typeof r.body.project === 'object' ? r.body.project : null, hidden: r.body.hidden === true, words: one(r.body.words), via: one(r.body.via) };
  }
  /** R5 (H133): records a person's decision on a draft of Timmy's, once its save is on disk (POST /api/canvas/drafts). */
  async function draftDecision(body) {
    if (!token) return { status: 0, ok: false, body: { ok: false, error: session.get().words } };
    const r = await request('/api/canvas/drafts', 'POST', token, body);
    if (r.status === 401) noted(r, 'Timmy refused to record the decision.');
    return r;
  }
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
    const mode = cardMode(rec.type, shape.props, now, token !== null, shape.meta);
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
      // R4 (H109; r25 D9 c): a parameter card placed for an operation keeps what that operation used beside the file now, and a
      // workflow card that operation's own run beside the newest
      const kept = boundDetail(keptDetail(card.detail), boundOperation(r), answer, r.props.data);
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
   * none (it says why, and "never read"). R4 (H109): placed for operation `op`, a parameter card holds what it used, and a
   * workflow card its own run (boundDetail).
   */
  const propsFor = (card, answer, type, op = null) => ({
    w: WIDTH[type], h: 160, card: card.id, kind: card.kind, projectId: answer.project.id, project: answer.project.name, title: card.title, command: card.command,
    data: answer.detail === false ? null : boundDetail(keptDetail(card.detail), op, answer, null), readAt: answer.detail === false ? '' : answer.madeAt, open: false, gone: false,
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
    // R4 (H109; r25 D9): one press is one step of tldraw's undo: the mark below, then the cards, their arrows and the page's
    // record, and nothing else (a drawn card's height and the cards' readings are written outside the history; the camera is
    // not in it). A press that adds nothing writes nothing, so it leaves no empty step behind.
    const adding = plan.place.length > 0 || plan.links.length > 0;
    if (adding) editor.markHistoryStoppingPoint(`timmy place operation ${op.id}`);
    const made = rowLayout(plan.place, start, widthOf).map((at) => {
      const card = cards.get(at.card);
      const type = drawnType(card.kind);
      const shape = deps.createShapeId();
      // R4 (H109): placed for this operation, so a parameter card shows the values the operation used (boundDetail)
      editor.createShape({ id: shape, type: CARD_SHAPES[type], x: at.x, y: at.y, props: propsFor(card, answer, type, op.id), meta: { timmyOperation: op.id } });
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
    if (adding) {
      const now = editor.getPage(page.id) ?? page;
      const record = { v: 1, project: answer.project.name, placed: [...kept.placed, ...made], links: [...kept.links, ...drawn], at: new Date().toISOString() };
      editor.updatePage({ id: page.id, meta: { ...(now.meta || {}), [PLACEMENTS]: { ...held, [key]: record } } });
    }
    const shown = [...shapeOf.values()].filter((id) => editor.getShape(id) && editor.getAncestorPageId(id) === page.id);
    // R4 (H109; r25 D9): the person's selection stays as it was (it had been the placed cards, all together, so the next drag
    // on one of them moved them all); the band offers to select what was placed (`select`)
    try { deps.reveal(editor, shown); } catch { /* showing them is a courtesy */ }
    await revealSized(editor, shown);
    const words = placementWords(op.id, { ...plan, drawn: drawn.length });
    return { operation: op.id, placed: made, already: plan.already, deleted: plan.deleted, skipped: plan.skipped, arrows: drawn, cut: plan.cut, gone: plan.gone, linked: plan.linked, words, select: made.map((m) => m.shape) };
  }

  /**
   * R4 (H109; r25 D9): a drawn card a person deletes takes with it the arrows "Place this operation" drew to or from it
   * (isTimmyArrow), in the same step of tldraw's undo. tldraw tells its listeners which shapes a delete removes before it removes
   * any of them ('deleted-shapes', from Editor.deleteShapes: the Delete key, the menu's Delete, Cut, the eraser), while the arrows
   * are still bound to the cards; the arrows are deleted right there, inside that delete, so one undo brings the cards and the
   * arrows back together. An arrow the person drew is never touched (tldraw leaves it where it ended, as it always does). The
   * band says what Timmy removed. Returns a function that detaches it.
   */
  function attach(editor) {
    let inner = false;
    const onDeleted = (ids) => {
      if (inner || !Array.isArray(ids) || ids.length === 0) return;
      const going = new Set(ids);
      const deleted = ids.map((id) => editor.getShape(id)).filter((s) => s && isDrawnCard(s));
      if (deleted.length === 0) return;
      const timmy = new Set();
      const theirs = new Set();
      for (const c of deleted) {
        for (const b of editor.getBindingsToShape(c.id, 'arrow')) {
          const arrow = editor.getShape(b.fromId);
          if (!arrow || going.has(arrow.id)) continue;
          (isTimmyArrow(arrow) ? timmy : theirs).add(arrow.id);
        }
      }
      if (timmy.size) {
        inner = true;
        try { editor.deleteShapes([...timmy]); } finally { inner = false; }
      }
      const words = removalWords(deleted.map((c) => c.props.title || c.props.card), timmy.size, theirs.size);
      if (words) { try { deps.say?.(words); } catch { /* the band is a courtesy */ } }
    };
    editor.on('deleted-shapes', onDeleted);
    return () => editor.off('deleted-shapes', onDeleted);
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

  /**
   * R4 (H109): Run detail, beside Details, on a card that names its operation: that operation's run detail (made by Timmy, of the
   * card's own project) in the side panel. Null when the card names none, or this page cannot show one.
   */
  function runDetailButton(op, projectId) {
    if (!op || typeof op !== 'object' || typeof op.id !== 'string' || !OPERATION_ID.test(op.id) || !deps.runDetail) return null;
    return h('button', {
      type: 'button', className: 'tc-rd', onPointerDown: handled, onClick: () => deps.runDetail(op.id, projectId || null),
      title: `Shows the run detail of operation ${op.id} in Timmy's side panel: its verdict, stage, exits, freshness, acceptance, files, receipts and cost, each with the record it came from`,
    }, 'Run detail');
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
          // R4 (H109): Details, and Run detail (the operation's run detail in the side panel) beside it
          h('span', { className: 'tc-foot-acts' },
            h('button', { type: 'button', className: 'tc-toggle', 'aria-expanded': String(!!p.open), onPointerDown: handled, onClick: toggle }, p.open ? 'Hide details' : 'Details'),
            mode.withheld ? null : runDetailButton(op, p.projectId)),
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
    const mode = cardMode(type, p, now, sess.state === 'ok' && token !== null, shape.meta);
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
  function Highlight({ path, projectId }) {
    const [src, setSrc] = React.useState(null);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
      let made = null;
      let gone = false;
      // R4 (H109): of the card's own project
      image(path, projectId).then((url) => {
        if (gone) { forget(url); return; }
        made = url;
        if (url) setSrc(url); else setFailed(true);
      }, () => { if (!gone) setFailed(true); });
      return () => { gone = true; forget(made); };
    }, [path, projectId]);
    if (src) return h('img', { src, alt: `highlight ${path}`, title: path, draggable: false, 'data-tc-image': path });
    return span('tc-note', failed ? `highlight ${path}: not read now` : `highlight ${path}: reading…`);
  }

  /** R4 (H109): a run's words on a workflow card: its target, its word (failed and interrupted in red), prediction, time, receipt. */
  const runWords = (lead, r) => h('p', { className: 'tc-last' }, `${lead} (${r.target}): `, span(r.word === 'failed' || r.word === 'interrupted' ? 'tc-bad' : '', r.word),
    `${r.met === true ? ', its prediction met' : r.met === false ? ', its prediction not met' : ''}${r.took ? ` · ${r.took}` : ''}${r.receipt ? ` · receipt ${r.receipt}` : ''}`);
  const jobWords = (r) => `job ${r.job}${r.predicted ? ` · prediction receipt ${r.predicted}` : ''}${r.receipt ? ` · outcome receipt ${r.receipt}` : ''}`;

  function WorkflowCard({ shape }) {
    const { own, mode, detail, readAt, now } = useCard(shape, 'workflow');
    const p = shape.props;
    const d = detail && detail.type === 'workflow' ? detail : null;
    const busy = !!(own && own.busy);
    // R4 (H109): placed for an operation: that operation's own run (boundRun), unless the newest run is its own; never the
    // newest run in its place. Its blocks show the states its own runs left; the newest run is said beside it.
    const bound = boundOperation(shape);
    const ownRun = !!bound && !!d && !!d.operation && d.operation.id === bound;
    const ran = bound && d && !ownRun && !mode.withheld && p.data && p.data.type === 'workflow' && p.data.ran && p.data.ran.operation === bound ? p.data.ran : null;
    const stateOf = (b) => {
      if (!ran) return b;
      const x = ran.state === 'recorded' ? (ran.blocks || []).find((y) => y.name === b.name) : null;
      return x ? { ...b, word: x.word, glyph: x.glyph, detail: x.detail } : { ...b, word: 'unknown', glyph: '?', detail: '' };
    };
    const blocks = d ? d.blocks.map(stateOf) : [];
    // R4 (H81): each Run button carries its own recorded action (actRef): the block it was drawn for, never one read at the click
    // R4 (H88): a document that names two blocks alike runs none of them (its notRunnable words say so once, above them)
    const runOf = (b) => (mode.executable && d.runnable && b.runnable
      ? h('button', { type: 'button', className: 'tc-btn', 'data-tc-act': 'run', 'data-tc-block': b.name, disabled: busy, ref: actRef(shape, 'workflow', runAct(d, b.name), !busy), onPointerDown: handled, title: `Sends /run ${d.doc} ${b.name} to Timmy (Run up to here)` }, 'Run up to here')
      : d.runnable && b.runnable ? cmd(`/run ${d.doc} ${b.name}`) : one(d.notRunnable) ? null : span('tc-note', '/run cannot name this block as one word'));
    const last = d && d.last;
    const its = ran && ran.state === 'recorded' ? ran.last : null;
    // the run whose record, error and files Details shows: the operation's own on a card placed for one (none when unknown)
    const shown = bound && !ownRun ? its : last;
    const record = bound && !ownRun ? (now && Array.isArray(now.operations) ? now.operations : []).find((o) => o && o.id === bound) : null;
    const op = !bound || ownRun ? (d ? d.operation : undefined)
      : { id: bound, from: 'the operation it was placed for (Place this operation)', request: record ? record.request ?? null : null, state: record ? record.state ?? null : null };
    // the newest run, beside the operation's own: whose it is, as its job record says
    const newest = last ? `now: the newest run of ${d.doc} (${last.target}) is ${last.word}, ${d.operation && d.operation.id ? `by operation ${d.operation.id}` : 'by no operation its job record names'}` : `now: ${d ? d.doc : 'the document'} has no run`;
    let lastLine;
    if (!bound) lastLine = last ? runWords('Newest run', last) : d ? words('tc-note', 'Not run yet.') : null;
    else if (ownRun) lastLine = last ? runWords(`Run of operation ${bound}`, last) : null;
    else if (its) lastLine = h(React.Fragment, null, runWords(`Run of operation ${bound}`, its), ran.asLastRead ? words('tc-note tc-ran-last', '(as last read)') : null, words('tc-note tc-now-run', newest));
    else if (ran) lastLine = h(React.Fragment, null, h('p', { className: 'tc-last tc-warn' }, `Run of operation ${bound}: unknown (${ran.why})`), words('tc-note tc-now-run', newest));
    else lastLine = d && !mode.withheld ? h(React.Fragment, null, h('p', { className: 'tc-last tc-warn' }, `Run of operation ${bound}: not read yet`), words('tc-note tc-now-run', newest)) : null;
    return h(Frame, {
      shape, type: 'workflow', mode, follows: mode.follows, answer: own, readAt, op,
      details: d ? [
        dl([['document', d.doc], ['sha256', d.sha256 || 'not hashed'], ['card', p.card], ['project', `${p.project} (${p.projectId})`],
          its ? [`run of operation ${bound}`, jobWords(its)] : null,
          last ? ['newest run', jobWords(last)] : null,
          shown && shown.note ? ['its record says', shown.note] : null, shown && shown.error ? ['error', shown.error] : null]),
        ...blocks.map((b) => h('div', { key: `c${b.key}`, className: 'tc-block-cmd' }, span('tc-k', `${b.name}${b.needs.length ? ` (needs ${b.needs.join(', ')})` : ''}`), ...b.command.map((l, i) => h('code', { key: i }, l)))),
        ...(shown ? (shown.outputs || []).map((o) => h('div', { key: `o${o.path}`, className: 'tc-out' }, span('tc-path', o.path), ' ', span('tc-note', o.now))) : []),
        shown && shown.more ? words('tc-note', `${shown.more} more files`) : null,
      ] : words('tc-note', mode.withheld ? 'Its blocks and their commands are withheld here.' : 'No reading of this document yet.'),
    },
    d && one(d.notRunnable) ? h('p', { className: 'tc-note tc-warn tc-twice' }, d.notRunnable) : null,
    d ? h('ol', { className: 'tc-blocks' }, ...blocks.map((b) => h('li', { key: b.key, className: `tc-block tc-w-${String(b.word).replace(/[^a-z]/g, '')}` },
      span('tc-glyph', b.glyph, { 'aria-hidden': 'true' }), ' ', span('tc-name', b.name), ' ', span(`tc-word ${b.word === 'failed' || b.word === 'interrupted' ? 'tc-bad' : b.word === 'unknown' ? 'tc-warn' : ''}`, b.word),
      b.detail ? span('tc-note', ` · ${b.detail}`) : null, h('div', { className: 'tc-acts' }, runOf(b))))) : mode.withheld ? withheldBody(p) : words('tc-note', p.command),
    lastLine);
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

  /**
   * R4 (H109; r25 D9 c): a parameter card placed for an operation ("Place this operation"): what that operation used of the
   * file, from its own records (boundDetail; src/studio/used-values.ts), labelled "as used by operation o…", each value beside
   * the file as it is now ("now 160 in recipes/tray.params.json") and never replaced by it; "unknown", with why, when its
   * records do not say. It is a record: nothing on it changes the file (the file's own card, Place card in the panel, does).
   */
  function BoundParamsCard({ shape }) {
    const { own, mode, detail, readAt, now } = useCard(shape, 'params');
    const p = shape.props;
    const op = boundOperation(shape);
    const d = detail && detail.type === 'params' ? detail : null;
    // what it used, as this card keeps it (onAnswer writes it from each reading: boundDetail)
    const used = p.data && p.data.type === 'params' && p.data.used && p.data.used.operation === op ? p.data.used : null;
    const record = (now && Array.isArray(now.operations) ? now.operations : []).find((o) => o && o.id === op);
    const file = d ? d.file : 'its parameter file';
    const shownMode = {
      ...mode, executable: false, badge: 'record',
      words: mode.withheld || !mode.follows ? mode.words : `A record of operation ${op}: what it used of ${file}, beside the file as it is now. Nothing on this card changes the file; the file's own card does (Place card in the panel).`,
    };
    const known = !!used && used.state === 'recorded';
    const fileNow = !!d && d.state === 'ok';
    const names = [...new Set([...(known ? used.values.map((v) => v.name) : []), ...(fileNow ? (d.values || []).map((v) => v.name) : [])])];
    const todayOf = (name) => { const v = fileNow ? (d.values || []).find((x) => x.name === name) : null; return v ? `now ${shownValue(v.value)}${v.unit ? ` ${v.unit}` : ''} in ${d.file}` : null; };
    // each value as used, and under it (as the file's own card puts a value's help) what the file holds now where it differs
    const rows = names.flatMap((name) => {
      const u = known ? used.values.find((v) => v.name === name) : null;
      const beside = u ? nowBeside(name, u.value, d) : todayOf(name);
      return [
        h('tr', { key: `u${name}`, 'data-tc-used': name },
          h('th', { scope: 'row' }, name),
          h('td', { className: 'tc-as-used' }, u ? span('tc-value', `${shownValue(u.value)}${u.unit ? ` ${u.unit}` : ''}`) : span('tc-note tc-warn', known ? 'not recorded' : 'unknown'))),
        ...(beside ? [h('tr', { key: `n${name}`, className: 'tc-help-row', 'data-tc-now': name }, h('td', null), h('td', { className: 'tc-now' }, span('tc-note', beside)))] : []),
      ];
    });
    const same = known && used.sha256 && d && d.base === used.sha256;
    const head = !used ? ': not read yet' : known ? (used.verified ? '' : ' (not verified)') : ': unknown';
    const opNow = { id: op, from: 'the operation it was placed for (Place this operation)', request: record ? record.request ?? null : null, state: record ? record.state ?? null : null };
    const build = d && d.build;
    return h(Frame, {
      shape, type: 'params', mode: shownMode, follows: mode.follows, answer: own, readAt, op: opNow,
      details: d ? [dl([['file', d.file], ['as used, sha256', used && used.sha256 ? used.sha256 : 'not named by its records'], ['now, sha256', d.base || 'no file'],
        ['read from', used ? used.from : 'not read yet'], ['card', p.card], ['project', `${p.project} (${p.projectId})`]]),
      ...(build ? [dl([['today\'s newest build', `${build.title} · ${build.word}`], ...build.facts.map((f) => [f.label, `${f.value} (${f.how})`])])] : []),
      ] : words('tc-note', mode.withheld ? 'Its values are withheld here.' : 'No reading of this file yet.'),
    },
    mode.withheld ? withheldBody(p) : h('p', { className: 'tc-used' }, 'As used by operation ', h('code', { className: 'tc-op-id' }, op), span(known && used.verified ? '' : 'tc-warn', head), used && used.asLastRead ? span('tc-note', ' (as last read)') : null),
    used && !mode.withheld ? words('tc-note tc-used-from', used.from) : null,
    rows.length ? h('table', { className: 'tc-table tc-used-table' }, h('tbody', null, ...rows)) : null,
    d && !fileNow ? words('tc-note', d.state === 'none' ? `${d.file} is not there now.` : `${d.file} is not usable now: ${d.error}`) : null,
    same ? words('tc-note', `${d.file} holds the same bytes now.`) : null,
    used && used.build ? h('p', { className: 'tc-build' }, 'Its build: ', used.build) : null,
    h('div', { className: 'tc-acts' }, cmd(`/op ${op}`), d ? cmd(`/open ${d.file}`) : null),
    d && d.notice ? h('p', { className: 'tc-notice' }, d.notice) : null);
  }

  /** R4 (H109): a parameter card draws as the file's own card, or as a record of the operation it was placed for. */
  function ParamsAnyCard({ shape }) {
    return boundOperation(shape) ? h(BoundParamsCard, { shape }) : h(ParamsCard, { shape });
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
      ? h(Highlight, { key: im.path, path: im.path, projectId: p.projectId })
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
  // R4 (H109): a parameter card placed for an operation draws as the record of what it used (ParamsAnyCard)
  const utils = [make('workflow', WorkflowCard), make('params', ParamsAnyCard), make('result', ResultCard)];
  return {
    utils, startSession, onAnswer, wantsFast, place,
    // R4 (H100): an operation's cards at once, left to right in the order they ran, linked
    placeOperation,
    // R4 (H109): a deleted drawn card takes Timmy's arrows to or from it (each editor, as it mounts: canvas.js attachEditor)
    attach,
    // R4 (H81): the panel's reading of the project (with the detail only through this page's session)
    read,
    // R4 (H109): an operation's run detail, made by Timmy, read with this page's session (the side panel's Run detail)
    runDetail,
    // R4 (H83): the canvas, its settings, its jobs and the bridge, each with this page's session (never handed out)
    hasSession, config, loadDocument, saveDocument, jobs, bridgeSocket, sessionEnded,
    // R5 (H133): the shared workspace frame, for the strip above the canvas
    workspace,
    // R5 (H133): a copy of this page's canvas when a newer one is on disk, and a decision on a draft of Timmy's
    keepCopy, draftDecision,
    // R6 (H139): a board's saved revision, and which project the canvas shows now
    health, active,
    setPoll: (f) => { poll = f; },
    /** R4 (H88): told when the session's state changes (the panel's line follows it). */
    setSessionListener: (f) => { onSession = typeof f === 'function' ? f : () => {}; },
    /** For the tests and the status line: the session in words (never the token). */
    session: () => session.get(),
  };
}
