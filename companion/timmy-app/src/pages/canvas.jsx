// R12 (the finish brief): Canvas — a bounded desk for this project (the Card Lab's finite workspace: the camera is held inside the
// desk, Fit shows all of it, never closer than 100 %), on the licensed tldraw SDK (its own licence state read the SDK's way and
// shown in words; its notice is never hidden). On the desk: Timmy's native Rive components (the Studio's versioned `timmy-rive`
// shape: AgentConsole, ProviderCard, ActionButton), Timmy's cards (the chosen model, the last receipt, the conversation: each
// says whether it was read on this page or not), and the person's own notes, drawings and arrows (an arrow binds to a card).
// Selection, connections, pan / zoom / Fit, the selected shape's parameters, delete, undo / redo: tldraw's own, with the desk's
// toolbar on the page's tools row. The desk is kept in Timmy's project storage (the companion's /api/app/desk: the principal's
// project, <TIMMY_HOME>/canvas/projects/<project id>/app-desk/, saved at a revision as the person works, never over a newer one),
// and it can be exported to a file and imported again (the footer).
import React, { memo, useEffect, useRef, useState } from 'react';
import {
  BaseBoxShapeUtil, DEFAULT_THEME, DefaultStylePanel, HTMLContainer, T, Tldraw, createShapeId, getSnapshot, loadSnapshot, react, resizeBox,
  toRichText, useEditor, useValue,
} from 'tldraw';
import { getAssetUrls } from '@tldraw/assets/selfHosted';
import 'tldraw/tldraw.css';
import { RIVE_COMPONENTS, RIVE_SHAPE, SAVED_WORDS, createRiveShape, riveProps } from '../../../studio-canvas/src/rive-shape.js';
import { createLicenseReadout } from '../../../studio-canvas/src/license-state.js';
import { timmyThemes } from '../../../studio-canvas/src/theme.js';
import { chosenOf, providerName, whereOf } from '../models-parts.jsx';
import { Page, Tool } from '../shell.jsx';
import { getJson, postJson } from '../api.js';
import { activityOf, answerNeedsYou, checkProvider, getState, goTo, projectQuery, say, send, setCanvasIo, setCanvasSelection, setLicense, stop, takeCanvasNote, useApp } from '../store.js';
import { ActionFace } from '../rive.jsx';
import { ASSET_STORE, ImportMenu } from './canvas-import.jsx';
import { DISPLAY_SHAPE, createDisplayUtil } from './display-node.jsx';
import { OP_SHAPE, addOperationNode, createOpUtil, operations } from './op-node.jsx';
import { AgentLayer } from './agent-panel.jsx';
import { useCatalog } from '../catalog.jsx';
import { MenuButton, MenuGroup, MenuItem } from '../menu.jsx';
import { Button, Facts, StateWord, clock, keepKeys, keepPointer, useIsolated } from '../ui.jsx';

// ── the desk ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The desk (the operator's 19:03 order): ONE sectioned rectangle of two long rows — RUN (ask → agent → proof) over SETUP
 * (connection, model, notes) — in page units. Fit fits the two rows' HEIGHT (at most 100 %), so the objects read at about
 * their own size, and the rows run on to the right: the camera pans along them, held inside the desk.
 */
export const SECTIONS = Object.freeze([
  { id: 'ask', row: 'RUN', label: '01 · Ask', x: 0, y: 0, w: 300, h: 372 },
  { id: 'agent', row: '', label: '02 · Agent', x: 328, y: 0, w: 440, h: 372 },
  { id: 'proof', row: '', label: '03 · Proof', x: 796, y: 0, w: 380, h: 372 },
  { id: 'connect', row: 'SETUP', label: '04 · Connection', x: 0, y: 396, w: 300, h: 276 },
  { id: 'model', row: '', label: '05 · Model', x: 328, y: 396, w: 440, h: 276 },
  { id: 'notes', row: '', label: '06 · Notes', x: 796, y: 396, w: 380, h: 276 },
]);
/** Where a section's object goes: under its label. */
const IN = (id) => { const s = SECTIONS.find((x) => x.id === id); return { x: s.x, y: s.y + 30 }; };
/** (the foot of the desk keeps 64 units free under the rows: the floating tools sit there, never over an object) */
export const DESK = Object.freeze({ x: -28, y: -28, w: 1232, h: 792 });
export const ZOOM_STEPS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]);
const quick = () => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);

/**
 * The desk's bounds: DESK, grown to hold every shape on it with the same margin — a desk saved with a larger layout (an earlier
 * build's, or a shape moved past the edge) is never partly out of reach of the camera.
 */
export function deskBounds(editor) {
  let x0 = DESK.x; let y0 = DESK.y; let x1 = DESK.x + DESK.w; let y1 = DESK.y + DESK.h;
  const b = editor ? editor.getCurrentPageBounds() : null;
  if (b) { x0 = Math.min(x0, b.x - 56); y0 = Math.min(y0, b.y - 56); x1 = Math.max(x1, b.x + b.w + 56); y1 = Math.max(y1, b.y + b.h + 56); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** The camera held on the desk (tldraw's own constraints: contain, fit at most 100 %, the wheel pans). */
/** A phone's stage (the page stacks at 900 px): there Fit is the Overview, the whole desk in view. */
export const phoneStage = (editor) => editor.getViewportScreenBounds().w < 650;
export function holdDesk(editor) {
  const vp = editor.getViewportScreenBounds();
  const phone = vp.w < 650;
  const padding = { x: phone ? 12 : 24, y: phone ? 12 : 24 };
  editor.setCameraOptions({
    isLocked: false, panSpeed: 1, zoomSpeed: 0.8, wheelBehavior: 'pan', zoomSteps: phone ? [0.1, 0.25, ...ZOOM_STEPS.slice(1)] : [...ZOOM_STEPS],
    // wide: fit the rows' height (never closer than 100 %), start at the rows' left end; the rows run on to the right. A phone
    // (G5): the whole desk in view first, its Overview, so no card or tool starts out of reach; a card is read by focusing it
    constraints: phone
      ? { bounds: deskBounds(editor), padding, origin: { x: 0.5, y: 0.5 }, initialZoom: 'fit-max', baseZoom: 'fit-max', behavior: 'contain' }
      : { bounds: deskBounds(editor), padding, origin: { x: 0, y: 0.5 }, initialZoom: 'fit-y-100', baseZoom: 'fit-y-100', behavior: 'contain' },
  });
}

/** The desk's cards and Rive components, in reading order (the rows, then left to right): what "Next card" steps through. */
export function deskCards(editor) {
  return editor.getCurrentPageShapes().filter((x) => x.type === CARD_SHAPE || x.type === RIVE_SHAPE)
    .sort((a, b) => (Math.abs(a.y - b.y) > 120 ? a.y - b.y : a.x - b.x));
}
/** A card brought to the front of the view: selected and zoomed to (its words readable), the inspector showing it. */
export function focusShape(editor, id) {
  editor.select(id);
  const b = editor.getShapePageBounds(id);
  if (!b) return;
  // after the inspector has opened under the stage (a resize re-holds the camera), the whole card fits the stage, clear of its floating tools and note (80 px above and below)
  const go = () => { const vp = editor.getViewportScreenBounds(); editor.zoomToBounds(b, { inset: 16, targetZoom: Math.min(2, Math.max(0.25, Math.min((vp.w - 32) / b.w, (vp.h - 160) / b.h))), animation: { duration: quick() } }); };
  requestAnimationFrame(() => requestAnimationFrame(go));
}
export function fitDesk(editor, animate = true) {
  holdDesk(editor);
  editor.setCamera(editor.getCamera(), { reset: true, animation: { duration: animate ? quick() : 0 } });
}

/** A short, stable key for a string (FNV-1a): the desk's storage key is made of the project, never of a path in plain words. */
export function keyOf(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
/** The board's key (its React key, so two principals or projects never share one open board): the principal the companion verified (config.principal, a one-way key) and the project — never shared between them. */
export const deskKeyOf = (config) => `timmy-desk-${keyOf(`${config && config.principal ? config.principal : 'operator'}|${config && config.project ? config.project.root : 'no-project'}`)}`;

// ── Timmy's cards on the desk ───────────────────────────────────────────────────────────────────────────────────────────

export const CARD_SHAPE = 'timmy-card';
/** The cards a person can put on the desk: each reads the store (the companion's answers on this page). */
export const DESK_CARDS = Object.freeze({
  model: { title: 'The chosen model', kicker: 'Model', w: 380, h: 220 },
  receipt: { title: 'The last receipt', kicker: 'Proof', w: 380, h: 230 },
  conversation: { title: 'This conversation', kicker: 'Conversation', w: 380, h: 220 },
});

function LiveLine({ at }) {
  return at ? <p className="ta-desk-live" title="read from the companion's Chat view (the records below list the request)">read on this page at {clock(at)}</p>
    : <p className="ta-desk-live is-not">not live: nothing was read on this page yet (as saved with the desk)</p>;
}

function DeskCard({ shape }) {
  const view = useApp((s) => s.view);
  const viewAt = useApp((s) => s.viewAt);
  const kind = DESK_CARDS[shape.props.kind] ? shape.props.kind : 'model';
  const body = useIsolated();
  const turns = view && view.conversation && Array.isArray(view.conversation.turns) ? view.conversation.turns : [];
  const sealed = turns.filter((t) => t.kind === 'timmy' && t.receipt);
  const last = sealed[sealed.length - 1];
  const chosen = chosenOf(view);
  let content = null;
  if (!view) content = <p className="ta-desk-big is-quiet">{shape.props.saved || 'Waiting for the companion.'}</p>;
  else if (kind === 'model') content = chosen ? <><p className="ta-desk-big">{chosen.model}</p><p className="ta-desk-sub">{whereOf(view.route)} · {view.route && view.route.ready ? 'Send is on' : 'Send is off'}</p></> : <><p className="ta-desk-big is-quiet">No model yet.</p><p className="ta-desk-sub">Choose one in Models &amp; accounts; Send stays off until then.</p></>;
  else if (kind === 'receipt') content = last ? <><p className="ta-desk-big"><span className={last.receipt.verified ? 'ta-verified' : 'ta-unverified'}>{last.receipt.verified ? '✓ Verified' : '✕ Not verified'}</span> <code>{last.receipt.id}</code></p><p className="ta-desk-sub">{last.model || 'a model'} · {last.receipt.where} · {clock(last.at)}</p></> : <><p className="ta-desk-big is-quiet">No sealed answer yet.</p><p className="ta-desk-sub">Each answer of this conversation is sealed with a receipt; the last one shows here.</p></>;
  else content = <><p className="ta-desk-big">{turns.filter((t) => t.kind === 'timmy').length} answers</p><p className="ta-desk-sub">{view.conversation ? view.conversation.total : 0} messages · {sealed.length} sealed with a receipt</p></>;
  return (
    <div className="ta-desk-card" data-desk-card={kind}>
      <header className="ta-desk-card-head"><span className="ta-desk-kicker">{DESK_CARDS[kind].kicker}</span><strong>{DESK_CARDS[kind].title}</strong></header>
      <div className="ta-desk-card-body" ref={body} onPointerDown={keepPointer} {...keepKeys}>
        {content}
        <LiveLine at={view ? viewAt : null} />
        {kind === 'model' ? <button type="button" className="ta-link" onClick={() => goTo('models')}>Models &amp; accounts →</button> : null}
        {kind === 'receipt' ? <button type="button" className="ta-link" onClick={() => goTo('runs')}>Runs &amp; receipts →</button> : null}
      </div>
    </div>
  );
}

class DeskCardUtil extends BaseBoxShapeUtil {
  static type = CARD_SHAPE;
  static props = { w: T.number, h: T.number, kind: T.string, saved: T.string };
  getDefaultProps() { return { w: 380, h: 220, kind: 'model', saved: '' }; }
  hideRotateHandle() { return true; }
  canEdit() { return false; }
  canBind() { return true; }
  onResize(shape, info) { const n = resizeBox(shape, info); return { ...n, props: { ...n.props, w: Math.max(240, n.props.w), h: Math.max(140, n.props.h) } }; }
  getText(shape) { return (DESK_CARDS[shape.props.kind] || DESK_CARDS.model).title; }
  component(shape) {
    return <HTMLContainer className="ta-desk-shape" style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}><DeskCard shape={shape} /></HTMLContainer>;
  }
  getIndicatorPath(shape) { const p = new Path2D(); p.roundRect(0, 0, shape.props.w, shape.props.h, 12); return p; }
}

// ── tldraw's parts, made once (a new object on a render makes tldraw build its store again) ─────────────────────────────────

let current = null;
const rive = createRiveShape({ React, BaseBoxShapeUtil, HTMLContainer, T, useValue, resizeBox, createShapeId, editor: () => current });
const license = createLicenseReadout({ react });
const DisplayUtil = createDisplayUtil(() => current);
let currentBoard = 'desk';
const OpUtil = createOpUtil(() => current, () => currentBoard, (editor, id) => focusShape(editor, id));
const SHAPE_UTILS = [rive.util, DeskCardUtil, DisplayUtil, OpUtil];
const OVERRIDES = { actions: (_e, actions) => { const { 'toggle-dark-mode': _d, ...kept } = actions; return kept; } };
const cssVar = (name, fallback) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; } };

/** Behind the shapes: the desk's edge, its caption and its corners (page space: it moves with the camera). */
function DeskEdge() {
  const config = useApp((s) => s.config);
  const editor = useEditor();
  const name = config && config.project ? config.project.name : 'this project';
  // the edge follows the desk's bounds (DESK, or larger when the shapes on it reach past it)
  const d = useValue('timmy desk: bounds', () => deskBounds(editor), [editor]);
  return (
    <div className="ta-desk" aria-hidden="true" style={{ left: d.x, top: d.y, width: d.w, height: d.h }}>
      {SECTIONS.map((x) => (
        <div key={x.id} className={`ta-desk-section is-${x.id}`} style={{ left: x.x - d.x - 12, top: x.y - d.y - 8, width: x.w + 24, height: x.h + 16 }}>
          {x.row ? <span className="ta-desk-section-k">{x.row}</span> : null}<span className={`ta-desk-section-label${x.row ? '' : ' is-alone'}`}>{x.label}</span>
        </div>
      ))}
      <i className="ta-desk-corner is-tl" /><i className="ta-desk-corner is-tr" /><i className="ta-desk-corner is-bl" /><i className="ta-desk-corner is-br" />
    </div>
  );
}
/** tldraw's style panel only while the person draws (a card or a Rive shape has no style of its own). */
function StylePanel(props) {
  const editor = useEditor();
  const shown = useValue('timmy desk: style panel', () => !['select', 'hand'].includes(editor.getCurrentToolId()) || editor.getSelectedShapes().some((x) => x.type !== CARD_SHAPE && x.type !== RIVE_SHAPE && x.type !== DISPLAY_SHAPE && x.type !== OP_SHAPE), [editor]);
  return shown ? <DefaultStylePanel {...props} /> : null;
}
const COMPONENTS = {
  OnTheCanvas: DeskEdge, StylePanel,
  Toolbar: null, PageMenu: null, MainMenu: null, NavigationPanel: null, HelpMenu: null, ActionsMenu: null, QuickActions: null,
  ZoomMenu: null, Minimap: null, DebugMenu: null, DebugPanel: null, MenuPanel: null, SharePanel: null, TopPanel: null,
};
let assetUrls = null;
let themes = null;

// ── what goes on the desk ───────────────────────────────────────────────────────────────────────────────────────────────

/** A free place on the desk for a new shape of w × h (the first spot in a 40-unit grid not under another shape). */
function placeFor(editor, w, h) {
  const taken = editor.getCurrentPageShapes().map((s) => editor.getShapePageBounds(s.id)).filter(Boolean);
  const inner = { x: DESK.x + 64, y: DESK.y + 64, w: DESK.w - 128, h: DESK.h - 128 };
  const free = (x, y) => !taken.some((b) => x < b.x + b.w + 16 && x + w + 16 > b.x && y < b.y + b.h + 16 && y + h + 16 > b.y);
  for (let y = inner.y; y + h <= inner.y + inner.h; y += 20) {
    for (let x = inner.x; x + w <= inner.x + inner.w; x += 20) if (free(x, y)) return { x, y };
  }
  // a full desk: the first free place in its margin, else beside the last shape (never on top of a card)
  for (let y = DESK.y + 8; y + h <= DESK.y + DESK.h - 8; y += 20) {
    for (let x = DESK.x + 8; x + w <= DESK.x + DESK.w - 8; x += 20) if (free(x, y)) return { x, y };
  }
  const last = taken[taken.length - 1];
  return last ? { x: last.x + 32, y: last.y + 32 } : { x: inner.x, y: inner.y };
}

export const NODES = Object.freeze([
  { id: 'activity', label: 'Agent console (Rive)', glyph: '>_' },
  { id: 'connection', label: 'Provider connection (Rive)', glyph: '○' },
  { id: 'welcome', label: 'Action button (Rive): sends a request', glyph: '▶' },
  { id: 'card:model', label: 'The chosen model', glyph: '◉' },
  { id: 'card:receipt', label: 'The last receipt', glyph: '✓' },
  { id: 'card:conversation', label: 'This conversation', glyph: '☰' },
  { id: 'note', label: 'A note', glyph: '✎' },
]);

export function addNode(editor, node) {
  const view = getState().view;
  const chosen = chosenOf(view);
  const provider = chosen ? chosen.source : 'ollama-local';
  let id = createShapeId();
  editor.run(() => {
    if (RIVE_COMPONENTS[node]) {
      const props = riveProps(node, node === 'connection' ? { provider, label: `${providerName(provider)} connection` } : node === 'welcome' ? { label: ACTION.label } : {});
      const at = placeFor(editor, props.w, 260);
      editor.createShape({ id, type: RIVE_SHAPE, x: at.x, y: at.y, props, ...(node === 'welcome' ? { meta: { request: ACTION.request } } : {}) });
    } else if (node.startsWith('card:')) {
      const kind = node.slice(5);
      const d = DESK_CARDS[kind] || DESK_CARDS.model;
      const at = placeFor(editor, d.w, d.h);
      editor.createShape({ id, type: CARD_SHAPE, x: at.x, y: at.y, props: { w: d.w, h: d.h, kind, saved: '' } });
    } else {
      const at = placeFor(editor, 200, 200);
      editor.createShape({ id, type: 'note', x: at.x, y: at.y, props: { richText: toRichText('') } });
    }
    editor.select(id);
  });
  // a new note is written at once (tldraw's own text editing; Escape ends it)
  if (node === 'note') { try { editor.setCurrentTool('select'); editor.setEditingShape(id); } catch { /* selected, not editing */ } }
  return id;
}

/** A note with text on the desk where there is room (a host operation's result: its words, operation and receipt). */
export function placeNote(editor, text) {
  const id = createShapeId();
  // in the Notes section where it is free (a note at 0.8 is 160 units wide, about 250 tall with these lines), else where
  // the desk has room for it whole
  const W = 168; const H = 250;
  const sec = SECTIONS.find((x) => x.id === 'notes');
  const taken = editor.getCurrentPageShapes().map((x) => editor.getShapePageBounds(x.id)).filter(Boolean);
  const free = (x, y) => !taken.some((b) => x < b.x + b.w + 12 && x + W + 12 > b.x && y < b.y + b.h + 12 && y + H + 12 > b.y);
  let at = null;
  for (let y = sec.y + 24; !at && y + H <= sec.y + sec.h + 4; y += 10) for (let x = sec.x + 8; !at && x + W <= sec.x + sec.w; x += 10) if (free(x, y)) at = { x, y };
  editor.run(() => {
    const p = at || placeFor(editor, W, H);
    editor.createShape({ id, type: 'note', x: p.x, y: p.y, props: { richText: toRichText(String(text || '')), size: 's', scale: 0.8 } });
    editor.select(id);
  });
  focusShape(editor, id);
  return id;
}

/** A new action button's words and the request it sends (the person changes both in the context column). */
export const ACTION = Object.freeze({ label: 'Ask Timmy', request: 'List the files in this project and say in one line what each is for.' });
/** The request an action button sends: its own (the shape's meta), else its label. */
export const requestOf = (shape) => (shape && shape.meta && typeof shape.meta.request === 'string' && shape.meta.request.trim() ? shape.meta.request.trim() : shape ? String(shape.props.label || '').trim() : '');

/** An arrow from one shape to another, bound at both ends (tldraw's own arrow and bindings: it follows them when they move). */
export function connect(editor, from, to) {
  const a = editor.getShapePageBounds(from);
  const b = editor.getShapePageBounds(to);
  if (!a || !b) return null;
  const id = createShapeId();
  const start = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const end = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  editor.createShape({ id, type: 'arrow', x: start.x, y: start.y, props: { start: { x: 0, y: 0 }, end: { x: end.x - start.x, y: end.y - start.y }, dash: 'dashed', size: 's' } });
  const at = (terminal, toId) => ({ type: 'arrow', fromId: id, toId, props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } });
  editor.createBindings([at('start', from), at('end', to)]);
  return id;
}

/**
 * The desk a project starts with (only when its desk is empty), as the Card Lab's desk holds its viewer and its identity card:
 * a few large objects joined by what flows between them — the action button that sends a request → the agent's console (its
 * state the turn's own events) ← the provider's connection; the console → the last receipt.
 */
function firstDesk(editor) {
  if (editor.getCurrentPageShapeIds().size) return;
  editor.run(() => {
    const view = getState().view;
    const chosen = chosenOf(view);
    const provider = chosen ? chosen.source : 'ollama-local';
    const action = createShapeId();
    const console = createShapeId();
    const link = createShapeId();
    const receipt = createShapeId();
    const model = createShapeId();
    const note = createShapeId();
    editor.createShape({ id: action, type: RIVE_SHAPE, ...IN('ask'), props: riveProps('welcome', { w: 300, label: ACTION.label }), meta: { request: ACTION.request } });
    editor.createShape({ id: console, type: RIVE_SHAPE, ...IN('agent'), props: riveProps('activity', { w: 440, label: 'Agent / tool activity' }) });
    editor.createShape({ id: receipt, type: CARD_SHAPE, ...IN('proof'), props: { w: 380, h: 230, kind: 'receipt', saved: '' } });
    editor.createShape({ id: link, type: RIVE_SHAPE, ...IN('connect'), props: riveProps('connection', { w: 300, provider, label: providerName(provider) }) });
    editor.createShape({ id: model, type: CARD_SHAPE, ...IN('model'), props: { w: 440, h: 200, kind: 'model', saved: '' } });
    editor.createShape({ id: note, type: 'note', ...IN('notes'), props: { richText: toRichText('Notes for this project') } });
    connect(editor, action, console);
    connect(editor, console, receipt);
    connect(editor, link, console);
    connect(editor, model, console);
  }, { history: 'ignore' });
}

// ── the desk kept in the project (the companion's /api/app/desk) ─────────────────────────────────────────────────────────

/** The project's first board (its desk); the unified Workspace order (2026-10-27) adds more boards beside it. */
export const FIRST_BOARD = 'desk';
/** The query of a board's desk route: the page's project and, for a board other than the desk, ?board=<id>. */
export function deskQuery(board) {
  const q = projectQuery();
  const b = board && board !== FIRST_BOARD ? `board=${encodeURIComponent(board)}` : '';
  return q ? (b ? `${q}&${b}` : q) : (b ? `?${b}` : '');
}
/** The board this browser last had open for a principal's project (a per-viewer convenience; the boards are the project's). */
const BOARD_KEPT = (deskKey) => `timmy-app:board:${deskKey}`;
function boardKept(deskKey) { try { return localStorage.getItem(BOARD_KEPT(deskKey)) || FIRST_BOARD; } catch { return FIRST_BOARD; } }
function keepBoard(deskKey, id) { try { localStorage.setItem(BOARD_KEPT(deskKey), id); } catch { /* not kept */ } }

/** The desk's document as the project keeps it: without the records of whoever had it open (tldraw's `user` records are per viewer). */
export function deskDocument(editor) {
  const doc = getSnapshot(editor.store).document;
  const store = {};
  for (const [id, r] of Object.entries(doc.store)) if (!(r && r.typeName === 'user')) store[id] = r;
  return { ...doc, store };
}
/**
 * The desk as compared before a save: the document without what only a viewing changes — a Rive shape's height follows its
 * content (its caption says where its state came from on THIS page), so a height measured differently is not a change of the desk.
 */
export function deskCompared(doc) {
  const store = {};
  for (const [id, r] of Object.entries(doc.store)) store[id] = r && r.type === RIVE_SHAPE && r.props ? { ...r, props: { ...r.props, h: 0 } } : r;
  return JSON.stringify({ ...doc, store });
}
/** How long after the person's last change the desk is saved. */
export const SAVE_AFTER_MS = 700;
/**
 * Saves the desk of `editor` to its project as the person works: each save at the next revision over the one this page has, so a
 * desk another window saved since is never written over (the companion keeps this page's version beside it as a copy, and
 * saving stops until the desk is opened again). The project is the one this page showed when the desk opened.
 */
export function keepDesk(editor, start, onState, board = FIRST_BOARD) {
  const q = deskQuery(board);
  let rev = start && Number.isInteger(start.revision) ? start.revision : 0;
  let timer = 0;
  let pending = false;
  let saving = false;
  let again = false;
  let stopped = false;
  let savedAt = start && start.savedAt ? start.savedAt : null;
  let last = start && start.snapshot ? deskCompared(deskDocument(editor)) : null;
  const save = async () => {
    clearTimeout(timer);
    pending = false;
    if (stopped) return;
    if (saving) { again = true; return; }
    const snapshot = deskDocument(editor);
    const text = deskCompared(snapshot);
    // a change that left the desk as it was saved (a face's word set again, a size measured the same) writes nothing
    if (text === last) { onState({ phase: 'saved', revision: rev, savedAt }); return; }
    saving = true;
    onState({ phase: 'saving', revision: rev });
    const r = await postJson(`/api/app/desk${q}`, { snapshot, baseRevision: rev, revision: rev + 1 });
    saving = false;
    if (r.ok) { rev = r.revision; last = text; savedAt = r.savedAt; onState({ phase: 'saved', revision: rev, savedAt }); }
    else if (r.conflict) {
      stopped = true;
      onState({ phase: 'conflict', revision: r.revision, words: `${r.error}${r.kept ? ` This page’s version was kept beside it (${r.kept}).` : ''}` });
      return;
    } else onState({ phase: 'failed', revision: rev, words: r.error || `The companion answered ${r.status}.` });
    if (again) { again = false; save(); }
  };
  const schedule = () => { if (stopped) return; if (!pending && !saving) onState({ phase: 'pending', revision: rev }); pending = true; clearTimeout(timer); timer = setTimeout(save, SAVE_AFTER_MS); };
  const off = editor.store.listen(schedule, { source: 'user', scope: 'document' });
  const hidden = () => { if (document.visibilityState === 'hidden' && pending) save(); };
  document.addEventListener('visibilitychange', hidden);
  return {
    now: save,
    /** the desk saved now and every save in flight finished: the revision the companion holds (for the agent's plan) */
    settled: async () => { await save(); for (let i = 0; i < 200 && (saving || pending); i++) await new Promise((r) => setTimeout(r, 50)); return rev; },
    stop: () => { if (pending) save(); stopped = true; clearTimeout(timer); off(); document.removeEventListener('visibilitychange', hidden); },
  };
}
/** What the band and the inspector say of where the desk is kept. */
export function keptWords(kept, project) {
  const where = `in the project${project ? ` ${project.name}` : ''}`;
  if (!kept || kept.phase === 'loading') return 'reading the project’s desk…';
  if (kept.phase === 'new') return `${where} · not saved yet`;
  if (kept.phase === 'pending') return `${where} · changes not saved yet`;
  if (kept.phase === 'saving') return `${where} · saving…`;
  if (kept.phase === 'saved') return `${where} · revision ${kept.revision}${kept.savedAt ? ` · ${clock(kept.savedAt)}` : ''}`;
  return `not saved: ${kept.words}`;
}
/** The tools row's few words of the same: how many shapes, and whether the desk is saved. */
export function deskWord(kept) {
  if (!kept || kept.phase === 'loading') return 'reading the desk…';
  if (kept.phase === 'new') return 'not saved yet';
  if (kept.phase === 'pending') return 'unsaved changes';
  if (kept.phase === 'saving') return 'saving…';
  if (kept.phase === 'saved') return `saved · revision ${kept.revision}${kept.savedAt ? ` · ${clock(kept.savedAt)}` : ''}`;
  return kept.phase === 'conflict' ? 'not saved: another window saved first' : 'not saved';
}
let keeper = null;

// ── export / import (the footer's buttons) ──────────────────────────────────────────────────────────────────────────────

export const DESK_FILE = 'timmy-desk';
function exportDesk(editor, project) {
  const file = { format: DESK_FILE, version: 1, project: project ? project.name : null, savedAt: new Date().toISOString(), snapshot: getSnapshot(editor.store) };
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(project ? project.name : 'timmy').replace(/[^\w.-]+/g, '-')}-canvas.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  say(`The canvas was exported as ${a.download} (${editor.getCurrentPageShapeIds().size} shapes).`);
}
function importDesk(editor) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      const file = JSON.parse(await f.text());
      if (!file || file.format !== DESK_FILE || !file.snapshot) { say(`Not imported: ${f.name} is not a Timmy canvas file.`); return; }
      loadSnapshot(editor.store, file.snapshot);
      if (keeper) keeper.now();
      holdDesk(editor);
      fitDesk(editor, false);
      say(`Imported ${f.name}${file.project ? ` (saved from ${file.project}` : ' ('}${file.savedAt ? ` at ${new Date(file.savedAt).toLocaleString()}` : ''}): its cards read this page’s answers; its Rive components say “as saved” until an event of this page moves them.`);
    } catch (e) { say(`Not imported: ${f.name} could not be read (${e instanceof Error ? e.message : String(e)}).`); }
  };
  input.click();
}

// ── the board ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const Board = memo(function Board({ licenseKey, start, onKept, onEditor, board = FIRST_BOARD }) {
  return (
    <Tldraw
      licenseKey={licenseKey || undefined}
      shapeUtils={SHAPE_UTILS}
      assets={ASSET_STORE}
      assetUrls={assetUrls || (assetUrls = getAssetUrls({ baseUrl: `${location.origin}/app/dist/assets/` }))}
      themes={themes || (themes = timmyThemes(DEFAULT_THEME, cssVar))}
      colorScheme="dark"
      overrides={OVERRIDES}
      components={COMPONENTS}
      onMount={(editor) => {
        current = editor;
        editor.user.updateUserPreferences({ colorScheme: 'dark' });
        // the project's desk as it was saved (only the document: the camera is the desk's own, Fit)
        let opened = true;
        if (start && start.ok && start.snapshot) {
          try { loadSnapshot(editor.store, { document: start.snapshot }); } catch (e) {
            opened = false;
            say(`The project’s saved desk could not be opened here (${e instanceof Error ? e.message : String(e)}): this desk is not saved, so the saved one is left as it is.`);
          }
        }
        holdDesk(editor);
        // the desk starts with Timmy's sections; a board made later starts blank (the page says how to begin)
        if (board === FIRST_BOARD) firstDesk(editor);
        fitDesk(editor, false);
        keeper = start && start.ok && opened ? keepDesk(editor, start, onKept, board) : null;
        if (keeper && !start.revision && editor.getCurrentPageShapeIds().size) keeper.now();
        if (start && !start.ok) onKept({ phase: 'failed', words: start.error || 'the companion did not answer.' });
        else if (!opened) onKept({ phase: 'failed', words: 'the saved desk could not be opened here.' });
        const onResize = () => holdDesk(editor);
        editor.on('resize', onResize);
        // a node made anywhere (an operation, its results, an agent's edit) grows the desk the camera is held on, once a frame
        let growing = 0;
        const stopGrow = editor.sideEffects.registerAfterCreateHandler('shape', () => { if (!growing) growing = requestAnimationFrame(() => { growing = 0; holdDesk(editor); }); });
        const stopLicense = license.watch(editor, (r) => setLicense(r));
        onEditor(editor);
        // a host operation's result sent here from Tools & integrations: a note on the desk (kept with it), selected
        const pending = keeper ? takeCanvasNote() : null;
        if (pending) placeNote(editor, pending.text);
        const mine = keeper;
        return () => { editor.off('resize', onResize); stopGrow(); if (growing) cancelAnimationFrame(growing); stopLicense(); if (mine) mine.stop(); if (keeper === mine) keeper = null; if (current === editor) current = null; onEditor(null); };
      }}
    />
  );
});

// ── the desk's toolbar (the page's tools row) and the selection (the context column) ────────────────────────────────────

function NodesMenu({ editor }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); const b = box.current && box.current.querySelector('button'); if (b) b.focus(); } };
    document.addEventListener('pointerdown', off);
    document.addEventListener('keydown', esc);
    requestAnimationFrame(() => { const first = box.current && box.current.querySelector('.ta-popover-item'); if (first) first.focus(); });
    return () => { document.removeEventListener('pointerdown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="ta-menu-wrap" ref={box}>
      <button type="button" className="ta-tool" aria-haspopup="menu" aria-expanded={open} disabled={!editor} onClick={() => setOpen(!open)} data-tool="Nodes">
        <span className="ta-tool-glyph" aria-hidden="true">＋</span><span className="ta-tool-label">Nodes</span>
      </button>
      {open && editor ? (
        <div className="ta-popover" role="menu" aria-label="Add to the desk">
          {NODES.map((n) => (
            <button key={n.id} type="button" role="menuitem" className="ta-popover-item" data-node={n.id} onClick={() => { setOpen(false); if (n.id !== 'note') editor.setCurrentTool('select'); addNode(editor, n.id); }}>
              <span className="ta-tool-glyph" aria-hidden="true">{n.glyph}</span>{n.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The boards of this project (the unified Workspace order): which is open, open another, make a new one (blank), rename the one
 * open. The list is the project's (GET /api/app/boards); a board's work is saved in the project as the desk's is.
 */
function BoardMenu({ boards, board, onOpen, onChanged }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState(null);
  const [words, setWords] = useState('');
  const list = boards && boards.ok ? boards.boards : [];
  const here = list.find((b) => b.id === board);
  const submit = async (close) => {
    const n = name.trim();
    if (!n) { setWords('A board needs a name.'); return; }
    const r = mode === 'rename' ? await postJson(`/api/app/boards/${encodeURIComponent(board)}/rename${projectQuery()}`, { name: n }) : await postJson(`/api/app/boards${projectQuery()}`, { name: n });
    if (!r.ok) { setWords(r.error || `The companion answered ${r.status}.`); return; }
    await onChanged();
    setName(''); setMode(null); setWords('');
    if (mode !== 'rename') onOpen(r.board.id);
    say(mode === 'rename' ? `Board renamed: ${r.board.name}.` : `Board made: ${r.board.name} (blank, kept in the project).`);
    close(true);
  };
  return (
    <MenuButton label={here ? here.name : 'Desk'} glyph="▦" title="Boards of this project" menuLabel="Boards of this project" data={{ 'data-menu': 'boards', 'data-board': board }} onOpen={() => { setMode(null); setWords(''); }}>
      {(close) => (
        <>
          <MenuGroup label="Boards">
            {list.length ? list.map((b) => (
              <MenuItem key={b.id} checked={b.id === board} close={close} onSelect={() => onOpen(b.id)} data={{ 'data-board-item': b.id }}
                hint={b.revision ? `revision ${b.revision}${b.savedAt ? ` · ${clock(b.savedAt)}` : ''}` : 'not saved yet'}>{b.name}</MenuItem>
            )) : <p className="ta-menu-note">{boards && !boards.ok ? boards.error : 'Reading the boards…'}</p>}
          </MenuGroup>
          <MenuGroup label="Change">
            <MenuItem keepOpen close={close} onSelect={() => { setMode('new'); setName(''); setWords(''); }} data={{ 'data-action': 'board-new' }}>New board…</MenuItem>
            <MenuItem keepOpen close={close} onSelect={() => { setMode('rename'); setName(here ? here.name : ''); setWords(''); }} data={{ 'data-action': 'board-rename' }}>Rename this board…</MenuItem>
          </MenuGroup>
          {mode ? (
            <form className="ta-menu-form" onSubmit={(e) => { e.preventDefault(); submit(close); }}>
              <label className="tr-visually-hidden" htmlFor="ta-board-name">{mode === 'rename' ? 'New name of this board' : 'Name of the new board'}</label>
              <input id="ta-board-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={mode === 'rename' ? 'New name' : 'Board name'} data-board-name />
              <button type="submit" className="ta-btn ta-btn-primary" data-action={mode === 'rename' ? 'board-rename-save' : 'board-create'}>{mode === 'rename' ? 'Rename' : 'Make'}</button>
            </form>
          ) : null}
          {words ? <p className="ta-menu-note" role="status">{words}</p> : null}
        </>
      )}
    </MenuButton>
  );
}

/**
 * The operations a node can run, from the ONE integration catalog (GET /api/catalog): each hosted app's Workspace
 * operations, callable or not — one that cannot run here is listed with its precise reason, never as a working button.
 */
function OpPicker({ editor }) {
  const { answer } = useCatalog();
  const [specs, setSpecs] = useState([]);
  useEffect(() => { operations().then(setSpecs); }, []);
  const entries = answer && answer.ok ? answer.catalog.entries.filter((e) => e.kind === 'app' && e.operations.some((o) => o.where.includes('canvas'))) : [];
  return (
    <MenuButton label="Operations" glyph="⚙" title="Add an operation node" menuLabel="Add an operation node" buttonClass="ta-tool" disabled={!editor} data={{ 'data-menu': 'operations', 'data-tool': 'Operations' }}>
      {(close) => (
        <>
          {!answer ? <p className="ta-menu-note">Reading the catalog…</p> : !entries.length ? <p className="ta-menu-note">No hosted app offers a Workspace operation here.</p> : entries.map((e) => (
            <MenuGroup key={e.id} label={e.name}>
              {e.operations.filter((o) => o.where.includes('canvas')).map((o) => {
                const spec = specs.find((x) => x.id === o.id);
                const why = e.states.installed.ok !== true ? e.states.installed.words : !spec ? 'not offered by this companion' : null;
                return <MenuItem key={o.id} close={close} disabled={Boolean(why)} hint={why || (spec && spec.heavy ? `It ${spec.heavy}.` : spec ? spec.lead : '')} data={{ 'data-op-pick': o.id, 'data-op-available': why ? 'no' : 'yes' }} onSelect={() => { const id = addOperationNode(editor, spec); focusShape(editor, id); }}>{o.label}</MenuItem>;
              })}
            </MenuGroup>
          ))}
          <MenuGroup label="Everything"><MenuItem close={close} onSelect={() => goTo('tools')} data={{ 'data-act': 'catalog' }} hint="every integration, in six facts">The integration catalog…</MenuItem></MenuGroup>
        </>
      )}
    </MenuButton>
  );
}

function DeskTools({ editor }) {
  const tool = useValue('timmy desk: tool', () => (editor ? editor.getCurrentToolId() : 'select'), [editor]);
  const zoom = useValue('timmy desk: zoom', () => (editor ? editor.getZoomLevel() : 1), [editor]);
  const canUndo = useValue('timmy desk: undo', () => (editor ? editor.getCanUndo() : false), [editor]);
  const canRedo = useValue('timmy desk: redo', () => (editor ? editor.getCanRedo() : false), [editor]);
  const off = !editor;
  const set = (id) => editor && editor.setCurrentTool(id);
  const z = (dir) => { if (!editor) return; const o = { animation: { duration: quick() } }; if (dir > 0) editor.zoomIn(editor.getViewportScreenCenter(), o); else editor.zoomOut(editor.getViewportScreenCenter(), o); };
  return (
    <>
      <Tool glyph="⌖" label="Arrange" pressed={tool === 'select'} onClick={off ? null : () => set('select')} />
      <Tool glyph="✋" label="Hand" pressed={tool === 'hand'} onClick={off ? null : () => set('hand')} />
      <NodesMenu editor={editor} />
      <OpPicker editor={editor} />
      <ImportMenu editor={editor} place={editor ? (w, h) => placeFor(editor, w, h) : null} focus={focusShape} hold={holdDesk} />
      <Tool glyph="✎" label="Draw" pressed={tool === 'draw'} onClick={off ? null : () => set('draw')} />
      <Tool glyph="↗" label="Connect" pressed={tool === 'arrow'} onClick={off ? null : () => set('arrow')} />
      <Tool glyph="T" label="Text" pressed={tool === 'text'} onClick={off ? null : () => set('text')} />
      <span className="ta-toolsrow-sep" aria-hidden="true" />
      <Tool icon glyph="↶" label="Undo" onClick={off || !canUndo ? null : () => editor.undo()} />
      <Tool icon glyph="↷" label="Redo" onClick={off || !canRedo ? null : () => editor.redo()} />
      <span className="ta-toolsrow-sep" aria-hidden="true" />
      <Tool icon glyph="−" label="Zoom out" onClick={off ? null : () => z(-1)} />
      <output className="ta-zoom" aria-label="Zoom level">{Math.round(zoom * 100)} %</output>
      <Tool icon glyph="+" label="Zoom in" onClick={off ? null : () => z(1)} />
      <Tool glyph="⛶" label="Fit workspace" onClick={off ? null : () => fitDesk(editor)} />
    </>
  );
}

/** The page stacks at 900 px (app.css): there the Canvas gives its controls as buttons in one bar under the stage. */
function usePhone() {
  const q = '(max-width: 900px)';
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const m = matchMedia(q); const f = () => setOn(m.matches);
    m.addEventListener('change', f); return () => m.removeEventListener('change', f);
  }, []);
  return on;
}

/**
 * G5: a phone's Canvas, every action a button (no gesture to guess): Overview (the whole desk), the card before and after
 * (each focused: zoomed to and shown in the inspector), Undo and Redo, and the rest of the tools behind "Tools". Pinch and
 * drag still pan and zoom; nothing here takes them away.
 */
function PhoneBar({ editor, toolsOpen, onTools }) {
  const cards = useValue('timmy desk: cards', () => (editor ? deskCards(editor).map((x) => x.id) : []), [editor]);
  const sel = useValue('timmy desk: one', () => (editor && editor.getSelectedShapeIds().length === 1 ? editor.getSelectedShapeIds()[0] : null), [editor]);
  const canUndo = useValue('timmy desk: undo', () => (editor ? editor.getCanUndo() : false), [editor]);
  const canRedo = useValue('timmy desk: redo', () => (editor ? editor.getCanRedo() : false), [editor]);
  const at = sel ? cards.indexOf(sel) : -1;
  const step = (d) => { if (!editor || !cards.length) return; const i = at < 0 ? (d > 0 ? 0 : cards.length - 1) : (at + d + cards.length) % cards.length; focusShape(editor, cards[i]); };
  const off = !editor;
  return (
    <div className="ta-phonebar" role="toolbar" aria-label="Canvas controls">
      <button type="button" className="ta-phonebtn is-primary" disabled={off} onClick={() => { editor.selectNone(); fitDesk(editor); }} data-phone="overview"><span aria-hidden="true">⛶</span> Overview</button>
      <span />
      <button type="button" className="ta-phonebtn" aria-expanded={toolsOpen} onClick={onTools} data-phone="tools">Tools {toolsOpen ? '▾' : '▸'}</button>
      <div className="ta-phonebar-row is-cards">
        <button type="button" className="ta-phonebtn" disabled={off || !cards.length} onClick={() => step(-1)} aria-label="The card before" data-phone="prev">◀</button>
        <span className="ta-phonebar-at" aria-live="polite">{at >= 0 ? `Card ${at + 1} of ${cards.length}` : `${cards.length} cards`}</span>
        <button type="button" className="ta-phonebtn" disabled={off || !cards.length} onClick={() => step(1)} aria-label="The next card" data-phone="next">▶</button>
        <button type="button" className="ta-phonebtn" disabled={off || !canUndo} onClick={() => editor.undo()} aria-label="Undo" data-phone="undo">↶</button>
        <button type="button" className="ta-phonebtn" disabled={off || !canRedo} onClick={() => editor.redo()} aria-label="Redo" data-phone="redo">↷</button>
      </div>
    </div>
  );
}

function runAction(shape) {
  const request = requestOf(shape);
  const t = getState().turn;
  if (!request) { say('This action button has no request yet: write one in the context column.'); return false; }
  if (t && ['running', 'stopping'].includes(t.phase)) { say('A turn is running: answer it or stop it first (the agent console’s controls, here or in Chat).'); return false; }
  if (!(getState().view && getState().view.route && getState().view.route.ready)) { say('No model is chosen for this project yet, so nothing was sent: choose one in Models & accounts.'); return false; }
  say(`Sent from the canvas: “${request}”. The agent console follows the turn; Chat shows it in full.`);
  send(request);
  return true;
}

/**
 * The current turn, wherever it was started (the canvas's action button or the Chat): its state, the tool it waits on with the
 * answers (Timmy's native ActionButton), Stop, and the receipt it was sealed with. The same store and routes as the Chat's.
 */
function TurnPanel({ theme }) {
  const turn = useApp((s) => s.turn);
  if (!turn) return <p className="ta-muted">No turn on this page yet. Press an action button on the desk, or write in Chat.</p>;
  const running = ['running', 'stopping'].includes(turn.phase);
  return (
    <div className="ta-turnpanel" data-phase={turn.phase}>
      <p className="ta-turnpanel-head"><StateWord word={activityOf(turn) === 'idle' ? turn.phase : activityOf(turn)} /> <span className="ta-muted">{turn.route && turn.route.model ? turn.route.model : 'the chosen model'}</span></p>
      <p className="ta-turnpanel-ask">“{String(turn.message || '').slice(0, 180)}”</p>
      {turn.tools.length ? <ul className="ta-tools">{turn.tools.map((x) => <li key={x.call}><StateWord word={x.status} /> {x.words}</li>)}</ul> : null}
      {turn.needsYou ? (
        <div className="ta-needs" role="alertdialog" aria-label="NEEDS YOU">
          <p className="ta-needs-head"><strong>NEEDS YOU</strong> · {turn.needsYou.tool}</p>
          <p>{turn.needsYou.words}</p>
          <div className="ta-row ta-answers">
            {(turn.needsYou.options || ['once', 'deny']).map((o) => (
              <ActionFace key={o} theme={theme} name={`desk-needs-you:${o}`} label={o === 'once' ? 'Allow once' : o === 'session' ? 'Allow for this session' : 'Deny'} onPress={() => answerNeedsYou(o)} />
            ))}
          </div>
        </div>
      ) : null}
      {running ? <Button kind="primary" onClick={stop} disabled={turn.phase === 'stopping'}>{turn.phase === 'stopping' ? 'Stopping…' : '■ Stop the turn'}</Button> : null}
      {turn.stopWords && running ? <p className="ta-muted" role="status">{turn.stopWords}</p> : null}
      {turn.error ? <p className="ta-result" role="status">{turn.error}</p> : null}
      {turn.done ? <p className="ta-receipt">{turn.done.receipt ? <>receipt <code>{String(turn.done.receipt).replace(/^sha256_/, '').slice(0, 12)}</code> · </> : null}{turn.done.status}</p> : null}
      <button type="button" className="ta-link" onClick={() => goTo('chat')}>Open in Chat →</button>
    </div>
  );
}

/** What a Rive shape does, in the context column: an action button's request, a connection's check, the console's turn. */
function RiveOps({ editor, one, theme }) {
  const check = useApp((s) => s.check);
  const meta = one.meta || {};
  if (one.props.component === 'welcome') {
    return (
      <div className="ta-fields">
        <label>Request it sends<textarea rows={3} value={typeof meta.request === 'string' ? meta.request : ''} placeholder={one.props.label} onChange={(e) => editor.updateShape({ id: one.id, type: one.type, meta: { ...meta, request: e.target.value } })} /></label>
        <Button kind="primary" onClick={() => runAction(one)}>▶ Send it now</Button>
        <p className="ta-muted">Pressing the button on the desk sends the same request: a real turn of this project, with its tools, their approvals and a receipt.</p>
      </div>
    );
  }
  if (one.props.component === 'connection') {
    const id = one.props.provider || 'ollama-local';
    const c = check && check[id];
    return (
      <div className="ta-fields">
        <Button kind="primary" onClick={() => checkProvider(id)} disabled={c && c.state === 'checking'}>{c && c.state === 'checking' ? 'Checking…' : `Check ${providerName(id)}`}</Button>
        <p className="ta-muted">{c ? <><StateWord word={c.state} /> {c.words}{c.at ? ` · ${clock(c.at)}` : ''}</> : 'Not checked on this page yet: the face shows the state as saved until a check answers.'}</p>
      </div>
    );
  }
  return <TurnPanel theme={theme} />;
}

function Selection({ editor, kept }) {
  const theme = useApp((s) => s.theme);
  const selected = useValue('timmy desk: selection', () => (editor ? editor.getSelectedShapes() : []), [editor]);
  const count = useValue('timmy desk: shapes', () => (editor ? editor.getCurrentPageShapeIds().size : 0), [editor]);
  const lic = useApp((s) => s.license);
  const config = useApp((s) => s.config);
  if (!editor) return <p className="ta-muted">Opening the desk…</p>;
  const one = selected.length === 1 ? selected[0] : null;
  const update = (props) => editor.updateShape({ id: one.id, type: one.type, props });
  const del = () => editor.deleteShapes(selected.map((s) => s.id));
  return (
    <div className="ta-inspect" onPointerDown={keepPointer} {...keepKeys}>
      {!selected.length ? (
        <>
          <p className="ta-inspect-title">Nothing selected</p>
          <p className="ta-muted">Select a card, a Rive component or a drawing to see and change its parameters. Add more from Nodes; connect two with Connect.</p>
          <Facts rows={[
            ['on the desk', `${count} shape${count === 1 ? '' : 's'}`],
            ['kept', keptWords(kept, config && config.project)],
          ]} />
          <p className="ta-context-k">THE TURN</p>
          <TurnPanel theme={theme} />
        </>
      ) : one ? (
        <>
          <p className="ta-inspect-title">{one.type === RIVE_SHAPE ? `Rive · ${RIVE_COMPONENTS[one.props.component] ? RIVE_COMPONENTS[one.props.component].artboard : one.props.component}` : one.type === CARD_SHAPE ? `Timmy card · ${(DESK_CARDS[one.props.kind] || DESK_CARDS.model).title}` : `tldraw · ${one.type}`}</p>
          {one.type === RIVE_SHAPE ? (
            <div className="ta-fields">
              <label>{one.props.component === 'welcome' ? 'Words on the button' : 'Label'}<input value={one.props.label} onChange={(e) => update({ label: e.target.value })} /></label>
              <label>Component<select value={one.props.component} onChange={(e) => { const f = riveProps(e.target.value, { w: one.props.w, provider: one.props.provider }); update({ component: e.target.value, state: f.state, label: f.label }); }}>
                {Object.keys(RIVE_COMPONENTS).map((k) => <option key={k} value={k}>{RIVE_COMPONENTS[k].artboard}</option>)}
              </select></label>
              {one.props.component === 'connection' ? (
                <label>Provider<select value={one.props.provider || ''} onChange={(e) => update({ provider: e.target.value, label: `${providerName(e.target.value)} connection`, state: riveProps('connection', { provider: e.target.value }).state })}>
                  {PROVIDERS.map((p) => <option key={p} value={p}>{providerName(p)}</option>)}
                </select></label>
              ) : null}
              {one.props.component === 'welcome' ? null : <p className="ta-muted">State word: <StateWord word={one.props.state} /> — {SAVED_WORDS} until an event of this page moves it.</p>}
              <RiveOps editor={editor} one={one} theme={theme} />
            </div>
          ) : one.type === CARD_SHAPE ? (
            <div className="ta-fields">
              <label>Shows<select value={one.props.kind} onChange={(e) => update({ kind: e.target.value })}>
                {Object.entries(DESK_CARDS).map(([k, d]) => <option key={k} value={k}>{d.title}</option>)}
              </select></label>
              <p className="ta-muted">A Timmy card reads this page’s answers from the companion; it says when it was read, and says “not live” when nothing was.</p>
            </div>
          ) : <p className="ta-muted">Its colour, fill and stroke are in tldraw’s style panel, shown while it is selected.</p>}
          <Facts rows={[['place', `${Math.round(one.x)}, ${Math.round(one.y)}`], ['size', one.props && one.props.w ? `${Math.round(one.props.w)} × ${Math.round(one.props.h)}` : null]]} />
        </>
      ) : <p className="ta-inspect-title">{selected.length} shapes selected</p>}
      {selected.length ? (
        <div className="ta-row">
          <Button onClick={() => editor.duplicateShapes(selected.map((s) => s.id), { x: 24, y: 24 })}>Duplicate</Button>
          <Button onClick={del}>Delete</Button>
        </div>
      ) : null}
      <div className="ta-license" data-license={lic ? lic.state : 'unread'}>
        <p className="ta-context-k">CANVAS LICENCE</p>
        <p>{lic ? <><StateWord word={lic.state} live={lic.state === 'licensed'} /> <span className="ta-muted">{lic.words}</span></> : <span className="ta-muted">Reading the SDK’s licence state…</span>}</p>
        <p className="ta-muted">Read from the SDK’s own licence manager (tldraw {config && config.tldrawVersion}); its notice and watermark are the SDK’s and are never hidden here.</p>
      </div>
    </div>
  );
}

/** Where the person last left the inspector layer on the stage (this browser only: a viewer's convenience, not the desk). */
const LAYER_KEY = 'timmy-app:canvas-layer';
const readLayer = () => { try { const v = JSON.parse(localStorage.getItem(LAYER_KEY) || 'null'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const keepLayer = (v) => { try { localStorage.setItem(LAYER_KEY, JSON.stringify(v)); } catch { /* not kept: a private window */ } };

/**
 * The inspector as a layer ON the canvas (the operator's 19:19 order: the canvas is the page; everything else small, folded and
 * movable): dragged by its header within the stage (arrow keys on the header move it too), folded to its header and opened
 * again; where it was left is kept in this browser. On a phone it sits under the stage, unfolded.
 */
function DeskLayer({ editor, kept, phone }) {
  const [at, setAt] = useState(() => ({ folded: true, ...readLayer() }));
  const chosen = useValue('timmy desk: chosen', () => (editor ? editor.getSelectedShapeIds().join(',') : ''), [editor]);
  // a phone: choosing a card opens the inspector under the stage (its parameters readable at the phone's size)
  useEffect(() => { if (phone && chosen) setAt((a) => (a.folded ? { ...a, folded: false } : a)); }, [phone, chosen]);
  const turn = useApp((s) => s.turn);
  // a tool waiting on the person opens the layer, whatever its fold (its answers are in it)
  const box = useRef(null);
  const drag = useRef(null);
  const waiting = Boolean(turn && turn.needsYou);
  const running = Boolean(turn && ['running', 'stopping'].includes(turn.phase));
  const folded = Boolean(at.folded) && !waiting;
  const save = (next) => { setAt(next); keepLayer(next); };
  const clamp = (x, y) => {
    const el = box.current; const stage = el && el.parentElement;
    if (!el || !stage) return { x, y };
    return { x: Math.max(8, Math.min(stage.clientWidth - el.offsetWidth - 8, x)), y: Math.max(8, Math.min(stage.clientHeight - 52, y)) };
  };
  const down = (e) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button'))) return;
    const el = box.current; if (!el) return;
    drag.current = { dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault(); e.stopPropagation();
  };
  const move = (e) => { const d = drag.current; if (!d) return; const p = clamp(e.clientX - d.dx, e.clientY - d.dy); setAt((a) => ({ ...a, ...p })); };
  const up = (e) => { if (!drag.current) return; drag.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ } setAt((a) => { keepLayer(a); return a; }); };
  const keys = (e) => {
    const step = e.shiftKey ? 64 : 16;
    const dir = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    const el = box.current; if (!el) return;
    save({ ...at, ...clamp(el.offsetLeft + dir[0], el.offsetTop + dir[1]) });
  };
  const style = Number.isFinite(at.x) && Number.isFinite(at.y) ? { left: at.x, top: at.y, right: 'auto' } : undefined;
  return (
    <section ref={box} className={`ta-layer${folded ? ' is-folded' : ''}`} style={style} aria-label="Inspector" onPointerDown={keepPointer} {...keepKeys}>
      <header className="ta-layer-head" onPointerDown={down} onPointerMove={move} onPointerUp={up} onKeyDown={keys} tabIndex={0}
        aria-label="Inspector: drag it, or move it with the arrow keys" title="Drag to move · arrow keys move it">
        <span className="ta-layer-grip" aria-hidden="true">⠿</span>
        <span className="ta-layer-title">Inspector</span>
        {waiting ? <span className="ta-layer-flag is-needs">NEEDS YOU</span> : running ? <span className="ta-layer-flag">working</span> : null}
        <button type="button" className="ta-layer-fold" aria-expanded={!folded} aria-label={folded ? 'Open the inspector' : 'Fold the inspector'} onClick={() => save({ ...at, folded: !folded })}><span aria-hidden="true">▾</span></button>
      </header>
      <div className="ta-layer-body" aria-hidden={folded ? 'true' : undefined} inert={folded}>
        <Selection editor={editor} kept={kept} />
      </div>
    </section>
  );
}

export default function CanvasPage() {
  const config = useApp((s) => s.config);
  const note = useApp((s) => s.note);
  const [editor, setEditor] = useState(null);
  const [desk, setDesk] = useState(null);
  const [kept, setKept] = useState({ phase: 'loading' });
  const [opening, setOpening] = useState(0);
  const deskKey = deskKeyOf(config);
  const ready = Boolean(config && config.ok);
  // the project's boards (the desk first) and the one open here
  const [boards, setBoards] = useState(null);
  const [board, setBoard] = useState(FIRST_BOARD);
  useEffect(() => { if (ready) setBoard(boardKept(deskKey)); }, [ready, deskKey]);
  const readBoards = async () => { const r = await getJson(`/api/app/boards${projectQuery()}`); setBoards(r); return r; };
  useEffect(() => { if (ready) readBoards(); }, [ready, deskKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // a board kept in this browser that the project no longer has (another principal's, a removed one): the desk
  useEffect(() => { if (boards && boards.ok && !boards.boards.some((b) => b.id === board)) setBoard(FIRST_BOARD); }, [boards, board]);
  const openBoard = (id) => { if (keeper) keeper.now(); keepBoard(deskKey, id); setBoard(id); };
  currentBoard = board;
  // the project's desk, read before the board opens (again after Reload, when another window saved it first)
  useEffect(() => {
    if (!ready) return undefined;
    let live = true;
    setDesk(null);
    setKept({ phase: 'loading' });
    getJson(`/api/app/desk${deskQuery(board)}`).then((d) => {
      if (!live) return;
      setDesk(d);
      if (d.ok) setKept({ phase: d.revision ? 'saved' : 'new', revision: d.revision, savedAt: d.savedAt });
      if (d.notice) say(d.notice);
    });
    return () => { live = false; };
  }, [ready, opening, board]);
  useEffect(() => {
    if (!editor) { setCanvasIo(null); return undefined; }
    setCanvasIo({ export: () => exportDesk(editor, config && config.project), import: () => importDesk(editor) });
    return () => setCanvasIo(null);
  }, [editor, config]);
  // the desk's action buttons: a person's press on the native ActionButton (a trusted click, Enter or Space: the bindings'
  // trigger, never automatic) sends that button's request as a real turn of this project
  useEffect(() => {
    const R = typeof window !== 'undefined' ? window.TimmyRive : null;
    if (!R || !editor) return undefined;
    return R.on((hd, ev) => {
      if (!ev || ev.input !== 'welcome' || !/^user /.test(String(ev.source || ''))) return;
      const el = hd && hd.hostEl && hd.hostEl.closest ? hd.hostEl.closest('[data-timmy-rive-shape]') : null;
      const shape = el ? editor.getShape(el.getAttribute('data-timmy-rive-shape')) : null;
      if (shape && shape.type === RIVE_SHAPE) runAction(shape);
    });
  }, [editor]);
  // G6: a Rive face on the desk is drawn for the zoom it is seen at (tldraw scales the shape with a transform, which a canvas
  // drawn at 100 % blurs): its drawing surface follows the camera's zoom, settled 150 ms after the zoom stops
  useEffect(() => {
    const R = typeof window !== 'undefined' ? window.TimmyRive : null;
    if (!R || !editor || typeof R.handles !== 'function') return undefined;
    let t = null;
    const sharpen = () => {
      const z = editor.getZoomLevel();
      const ratio = Math.min(4, (window.devicePixelRatio || 1) * Math.max(1, z));
      for (const h of R.handles()) {
        if (!h.rive || !h.hostEl || !h.hostEl.closest || !h.hostEl.closest('.ta-stage')) continue;
        try { h.rive.resizeDrawingSurfaceToCanvas(ratio); } catch { /* drawn as it was */ }
      }
    };
    const stop = react('timmy desk: rive sharpness', () => { editor.getZoomLevel(); clearTimeout(t); t = setTimeout(sharpen, 150); });
    return () => { clearTimeout(t); stop(); };
  }, [editor]);
  // the selection kept for the Control Room's "canvas selection" target: the board, its files and operation nodes
  useEffect(() => {
    if (!editor) return undefined;
    let t = null;
    const stopSel = react('timmy desk: selection kept', () => {
      const nodes = editor.getSelectedShapes().filter((x) => x.type === DISPLAY_SHAPE || x.type === OP_SHAPE).map((x) => ({ id: x.id, kind: x.type === OP_SHAPE ? 'operation' : 'file', title: String(x.props.title || x.props.path || x.props.op || '').slice(0, 80), path: x.props.path || null, op: x.props.op || null }));
      clearTimeout(t); t = setTimeout(() => setCanvasSelection({ board: currentBoard, nodes }), 120);
    });
    return () => { clearTimeout(t); stopSel(); };
  }, [editor]);
  const shapes = useValue('timmy desk: count', () => (editor ? editor.getCurrentPageShapeIds().size : 0), [editor]);
  const phone = usePhone();
  const [toolsOpen, setToolsOpen] = useState(false);
  // the Canvas is the page: no head, no band, no column beside it; the inspector and the tools are layers on the stage
  return (
    <Page id="canvas" fill head={false}>
      <div className="ta-stage is-page" aria-label="The desk">
        {ready && desk ? <Board key={`${deskKey}:${board}:${opening}`} board={board} licenseKey={config.licenseKey} start={desk} onKept={setKept} onEditor={setEditor} />
          : ready ? <p className="ta-empty ta-pad">Reading the project’s desk…</p>
          : <p className="ta-empty ta-pad">{config ? config.error || 'The companion did not answer.' : 'Opening the desk…'}</p>}
        {note ? <p className="ta-stage-note" role="status">{note}</p> : null}
        {editor && board !== FIRST_BOARD && shapes === 0 && desk && desk.ok ? <p className="ta-stage-guide" data-board-empty>This board is empty. Import an app’s result, add a node, or draw: everything on it is kept in the project.</p> : null}
        {phone ? <PhoneBar editor={editor} toolsOpen={toolsOpen} onTools={() => setToolsOpen(!toolsOpen)} /> : null}
        <DeskLayer editor={editor} kept={kept} phone={phone} />
        <AgentLayer editor={editor} board={board} settle={() => (keeper ? keeper.settled() : Promise.resolve(null))} />
        <div className={`ta-floatbar ta-toolsrow${phone && !toolsOpen ? ' is-phone-folded' : ''}`} role="toolbar" aria-label="Canvas tools">
          <BoardMenu boards={boards} board={board} onOpen={openBoard} onChanged={readBoards} />
          <span className="ta-toolsrow-sep" aria-hidden="true" />
          <DeskTools editor={editor} />
          {kept.phase === 'conflict' ? <Button kind="primary" onClick={() => setOpening(opening + 1)}>Open the saved desk</Button> : null}
          <span className="ta-toolsrow-note" data-kept={kept.phase} title={keptWords(kept, config && config.project)}>{editor ? `${shapes} shape${shapes === 1 ? '' : 's'} · ` : ''}{deskWord(kept)}</span>
        </div>
      </div>
    </Page>
  );
}
