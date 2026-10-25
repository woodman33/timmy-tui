// R12 (the finish brief): Canvas — a bounded desk for this project (the Card Lab's finite workspace: the camera is held inside the
// desk, Fit shows all of it, never closer than 100 %), on the licensed tldraw SDK (its own licence state read the SDK's way and
// shown in words; its notice is never hidden). On the desk: Timmy's native Rive components (the Studio's versioned `timmy-rive`
// shape: AgentConsole, ProviderCard, ActionButton), Timmy's cards (the chosen model, the last receipt, the conversation: each
// says whether it was read on this page or not), and the person's own notes, drawings and arrows (an arrow binds to a card).
// Selection, connections, pan / zoom / Fit, the selected shape's parameters, delete, undo / redo: tldraw's own, with the desk's
// toolbar on the page's tools row. The desk is kept per project in this browser (tldraw's store under a key made of the project),
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
import { getState, goTo, say, setCanvasIo, setLicense, useApp } from '../store.js';
import { Button, Facts, StateWord, clock, keepKeys, keepPointer, useIsolated } from '../ui.jsx';

// ── the desk ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The desk in page units: a 1248 × 652 work area inside a 64-unit margin (what Fit shows, and the camera's bounds). */
export const DESK = Object.freeze({ x: -64, y: -64, w: 1376, h: 780 });
export const ZOOM_STEPS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]);
const quick = () => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);

/** The camera held on the desk (tldraw's own constraints: contain, fit at most 100 %, the wheel pans). */
export function holdDesk(editor) {
  const vp = editor.getViewportScreenBounds();
  const padding = { x: vp.w < 650 ? 12 : 24, y: 24 };
  editor.setCameraOptions({
    isLocked: false, panSpeed: 1, zoomSpeed: 0.8, wheelBehavior: 'pan', zoomSteps: [...ZOOM_STEPS],
    constraints: { bounds: { ...DESK }, padding, origin: { x: 0.5, y: 0.5 }, initialZoom: 'fit-max-100', baseZoom: 'default', behavior: 'contain' },
  });
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
/** The desk's key: the principal the companion verified (config.principal, a one-way key) and the project — never shared between them. */
export const deskKeyOf = (config) => `timmy-desk-${keyOf(`${config && config.principal ? config.principal : 'operator'}|${config && config.project ? config.project.root : 'no-project'}`)}`;

// ── Timmy's cards on the desk ───────────────────────────────────────────────────────────────────────────────────────────

export const CARD_SHAPE = 'timmy-card';
/** The cards a person can put on the desk: each reads the store (the companion's answers on this page). */
export const DESK_CARDS = Object.freeze({
  model: { title: 'The chosen model', w: 340, h: 196 },
  receipt: { title: 'The last receipt', w: 340, h: 196 },
  conversation: { title: 'This conversation', w: 340, h: 196 },
});

function LiveLine({ at }) {
  return at ? <p className="ta-desk-live">read on this page at {clock(at)} · GET /api/chat/view</p>
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
  if (!view) content = <p className="ta-muted">{shape.props.saved || 'Nothing to show until the companion answers.'}</p>;
  else if (kind === 'model') content = chosen ? <><p className="ta-desk-big">{chosen.model}</p><p className="ta-muted">{whereOf(view.route)} · {view.route && view.route.ready ? 'Send is on' : 'Send is off'}</p></> : <p className="ta-muted">No model chosen · Send is off.</p>;
  else if (kind === 'receipt') content = last ? <><p className="ta-desk-big"><span className={last.receipt.verified ? 'ta-verified' : 'ta-unverified'}>{last.receipt.verified ? '✓ verified' : '✕ not verified'}</span> <code>{last.receipt.id}</code></p><p className="ta-muted">{last.model || 'a model'} · {last.receipt.where} · {clock(last.at)}</p></> : <p className="ta-muted">No sealed answer in this conversation yet.</p>;
  else content = <Facts rows={[['messages', String(view.conversation ? view.conversation.total : 0)], ['answers', String(turns.filter((t) => t.kind === 'timmy').length)], ['sealed', String(sealed.length)]]} />;
  return (
    <div className="ta-desk-card" data-desk-card={kind}>
      <header className="ta-desk-card-head"><strong>{DESK_CARDS[kind].title}</strong><span className="tr-badge">TIMMY</span></header>
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
  getDefaultProps() { return { w: 340, h: 196, kind: 'model', saved: '' }; }
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
const SHAPE_UTILS = [rive.util, DeskCardUtil];
const OVERRIDES = { actions: (_e, actions) => { const { 'toggle-dark-mode': _d, ...kept } = actions; return kept; } };
const cssVar = (name, fallback) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; } };

/** Behind the shapes: the desk's edge, its caption and its corners (page space: it moves with the camera). */
function DeskEdge() {
  const config = useApp((s) => s.config);
  const name = config && config.project ? config.project.name : 'this project';
  return (
    <div className="ta-desk" aria-hidden="true" style={{ left: DESK.x, top: DESK.y, width: DESK.w, height: DESK.h }}>
      <span className="ta-desk-caption">{name} · Canvas</span>
      <i className="ta-desk-corner is-tl" /><i className="ta-desk-corner is-tr" /><i className="ta-desk-corner is-bl" /><i className="ta-desk-corner is-br" />
    </div>
  );
}
/** tldraw's style panel only while the person draws (a card or a Rive shape has no style of its own). */
function StylePanel(props) {
  const editor = useEditor();
  const shown = useValue('timmy desk: style panel', () => !['select', 'hand'].includes(editor.getCurrentToolId()) || editor.getSelectedShapes().some((x) => x.type !== CARD_SHAPE && x.type !== RIVE_SHAPE), [editor]);
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
  { id: 'welcome', label: 'Action button (Rive)', glyph: '▶' },
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
      const props = riveProps(node, node === 'connection' ? { provider, label: `${providerName(provider)} connection` } : {});
      const at = placeFor(editor, props.w, 260);
      editor.createShape({ id, type: RIVE_SHAPE, x: at.x, y: at.y, props });
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

/** The desk a project starts with (only when its desk is empty): the agent's console, the chosen model and the last receipt. */
function firstDesk(editor) {
  if (editor.getCurrentPageShapeIds().size) return;
  editor.run(() => {
    const view = getState().view;
    const chosen = chosenOf(view);
    const provider = chosen ? chosen.source : 'ollama-local';
    editor.createShape({ id: createShapeId(), type: RIVE_SHAPE, x: 0, y: 0, props: riveProps('activity', { w: 480 }) });
    editor.createShape({ id: createShapeId(), type: RIVE_SHAPE, x: 520, y: 0, props: riveProps('connection', { w: 320, provider, label: `${providerName(provider)} connection` }) });
    editor.createShape({ id: createShapeId(), type: CARD_SHAPE, x: 880, y: 0, props: { w: 340, h: 196, kind: 'model', saved: '' } });
    editor.createShape({ id: createShapeId(), type: CARD_SHAPE, x: 880, y: 232, props: { w: 340, h: 196, kind: 'receipt', saved: '' } });
    editor.createShape({ id: createShapeId(), type: 'note', x: 0, y: 380, props: { richText: toRichText('Notes for this project: write here, draw beside the cards, connect them with arrows.') } });
  }, { history: 'ignore' });
}

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
      holdDesk(editor);
      fitDesk(editor, false);
      say(`Imported ${f.name}${file.project ? ` (saved from ${file.project}` : ' ('}${file.savedAt ? ` at ${new Date(file.savedAt).toLocaleString()}` : ''}): its cards read this page’s answers; its Rive components say “as saved” until an event of this page moves them.`);
    } catch (e) { say(`Not imported: ${f.name} could not be read (${e instanceof Error ? e.message : String(e)}).`); }
  };
  input.click();
}

// ── the board ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const Board = memo(function Board({ licenseKey, deskKey, onEditor }) {
  return (
    <Tldraw
      key={deskKey}
      persistenceKey={deskKey}
      licenseKey={licenseKey || undefined}
      shapeUtils={SHAPE_UTILS}
      assetUrls={assetUrls || (assetUrls = getAssetUrls({ baseUrl: `${location.origin}/app/dist/assets/` }))}
      themes={themes || (themes = timmyThemes(DEFAULT_THEME, cssVar))}
      colorScheme="dark"
      overrides={OVERRIDES}
      components={COMPONENTS}
      onMount={(editor) => {
        current = editor;
        editor.user.updateUserPreferences({ colorScheme: 'dark' });
        holdDesk(editor);
        firstDesk(editor);
        fitDesk(editor, false);
        const onResize = () => holdDesk(editor);
        editor.on('resize', onResize);
        const stopLicense = license.watch(editor, (r) => setLicense(r));
        onEditor(editor);
        return () => { editor.off('resize', onResize); stopLicense(); if (current === editor) current = null; onEditor(null); };
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

const PROVIDERS = ['ollama-local', 'openrouter', 'ollama-cloud', 'cloudflare'];

function Selection({ editor }) {
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
            ['kept', <span key="k">in this browser for {config && config.project ? config.project.name : 'this project'} (tldraw’s store, as you work)</span>],
          ]} />
        </>
      ) : one ? (
        <>
          <p className="ta-inspect-title">{one.type === RIVE_SHAPE ? `Rive · ${RIVE_COMPONENTS[one.props.component] ? RIVE_COMPONENTS[one.props.component].artboard : one.props.component}` : one.type === CARD_SHAPE ? `Timmy card · ${(DESK_CARDS[one.props.kind] || DESK_CARDS.model).title}` : `tldraw · ${one.type}`}</p>
          {one.type === RIVE_SHAPE ? (
            <div className="ta-fields">
              <label>Label<input value={one.props.label} onChange={(e) => update({ label: e.target.value })} /></label>
              <label>Component<select value={one.props.component} onChange={(e) => { const f = riveProps(e.target.value, { w: one.props.w, provider: one.props.provider }); update({ component: e.target.value, state: f.state, label: f.label }); }}>
                {Object.keys(RIVE_COMPONENTS).map((k) => <option key={k} value={k}>{RIVE_COMPONENTS[k].artboard}</option>)}
              </select></label>
              {one.props.component === 'connection' ? (
                <label>Provider<select value={one.props.provider || ''} onChange={(e) => update({ provider: e.target.value, label: `${providerName(e.target.value)} connection`, state: riveProps('connection', { provider: e.target.value }).state })}>
                  {PROVIDERS.map((p) => <option key={p} value={p}>{providerName(p)}</option>)}
                </select></label>
              ) : null}
              <p className="ta-muted">State word: <StateWord word={one.props.state} /> — {SAVED_WORDS} until an event of this page moves it.</p>
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
      <div className="ta-row">
        <Button onClick={() => exportDesk(editor, config && config.project)}>Export canvas</Button>
        <Button onClick={() => importDesk(editor)}>Import…</Button>
      </div>
      <div className="ta-license" data-license={lic ? lic.state : 'unread'}>
        <p className="ta-context-k">CANVAS LICENCE</p>
        <p>{lic ? <><StateWord word={lic.state} live={lic.state === 'licensed'} /> <span className="ta-muted">{lic.words}</span></> : <span className="ta-muted">Reading the SDK’s licence state…</span>}</p>
        <p className="ta-muted">Read from the SDK’s own licence manager (tldraw {config && config.tldrawVersion}); its notice and watermark are the SDK’s and are never hidden here.</p>
      </div>
    </div>
  );
}

export default function CanvasPage() {
  const config = useApp((s) => s.config);
  const note = useApp((s) => s.note);
  const count = useApp((s) => s.license);
  const [editor, setEditor] = useState(null);
  const deskKey = deskKeyOf(config);
  useEffect(() => {
    if (!editor) { setCanvasIo(null); return undefined; }
    setCanvasIo({ export: () => exportDesk(editor, config && config.project), import: () => importDesk(editor) });
    return () => setCanvasIo(null);
  }, [editor, config]);
  const shapes = useValue('timmy desk: count', () => (editor ? editor.getCurrentPageShapeIds().size : 0), [editor]);
  return (
    <Page id="canvas" fill note={note}
      actions={<Button onClick={() => editor && fitDesk(editor)} disabled={!editor}>Fit workspace</Button>}
      band={[
        ['DESK', editor ? `${shapes} shape${shapes === 1 ? '' : 's'}` : <span className="ta-muted">opening…</span>],
        ['KEPT', <span key="k">in this browser · {config && config.project ? config.project.name : 'no project'}</span>],
        ['LICENCE', count ? <StateWord word={count.state} live={count.state === 'licensed'} /> : <span className="ta-muted">reading…</span>],
      ]}
      context={<Selection editor={editor} />}
      tools={<DeskTools editor={editor} />}>
      <div className="ta-stage" aria-label="The desk">
        {config && config.ok ? <Board licenseKey={config.licenseKey} deskKey={deskKey} onEditor={setEditor} />
          : <p className="ta-empty ta-pad">{config ? config.error || 'The companion did not answer.' : 'Opening the desk…'}</p>}
      </div>
    </Page>
  );
}
