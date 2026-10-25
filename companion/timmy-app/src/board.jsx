// R12: the board — tldraw 5.5.2, bundled on this machine — with Timmy's cards as its shapes. Each of the app's three pages is a
// tldraw page (01 Connect · 02 Chat · 03 Review: the strip's step path switches them); each card is a `timmy-card` shape whose
// body is the card's own React (./cards.jsx), so a card can be moved and resized on the board and the person can draw, write
// and add notes beside it with tldraw's own tools. The board is kept by tldraw in this browser (its persistenceKey: IndexedDB,
// the drawing and the cards' places, never a token or a conversation); the cards themselves are the app's parts, so they are
// put back when missing and are not deleted with the drawing.
import { Box, BaseBoxShapeUtil, DEFAULT_THEME, DefaultStylePanel, HTMLContainer, PageRecordType, T, Tldraw, react, resizeBox, useEditor, useValue } from 'tldraw';
import { getAssetUrls } from '@tldraw/assets/selfHosted';
import 'tldraw/tldraw.css';
import { memo, useEffect, useRef } from 'react';
import { timmyThemes } from '../../studio-canvas/src/theme.js';
import { CARDS, PAGES, cardsOf } from './cards.jsx';
import { getState, goTo, useApp } from './store.js';

export const CARD_SHAPE = 'timmy-card';
export const pageIdOf = (page) => PageRecordType.createId(page);
export const cardIdOf = (card) => `shape:card-${card}`;
const MIN = { w: 320, h: 220 };

function CardOnBoard({ shape }) {
  const theme = useApp((s) => s.theme);
  const def = CARDS[shape.props.card];
  if (!def) return <div className="ta-card"><p className="ta-empty">This card ({shape.props.card}) is not part of this version of Timmy.</p></div>;
  const C = def.C;
  return <C theme={theme} />;
}

class TimmyCardUtil extends BaseBoxShapeUtil {
  static type = CARD_SHAPE;
  static props = { w: T.number, h: T.number, card: T.string };
  getDefaultProps() { return { w: 480, h: 360, card: 'chat' }; }
  hideRotateHandle() { return true; }
  canEdit() { return false; }
  canBind() { return false; }
  isAspectRatioLocked() { return false; }
  onResize(shape, info) {
    const next = resizeBox(shape, info);
    return { ...next, props: { ...next.props, w: Math.max(MIN.w, next.props.w), h: Math.max(MIN.h, next.props.h) } };
  }
  getText(shape) { return shape.props.card; }
  component(shape) {
    return (
      <HTMLContainer className="ta-shape" data-card-shape={shape.props.card} style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}>
        <CardOnBoard shape={shape} />
      </HTMLContainer>
    );
  }
  // no outline of its own: a card under the pointer is not drawn hovered (the pointer is over a card nearly always on this board);
  // a selected card shows tldraw's selection box and handles
  getIndicatorPath() { return new Path2D(); }
}

const cssVar = (name, fallback) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; } };

/** The app's pages and cards on the board: made when missing, never moved when they are there (the person's layout stands). */
export function ensureBoard(editor) {
  editor.run(() => {
    for (const p of PAGES) {
      const id = pageIdOf(p.id);
      if (!editor.getPage(id)) editor.createPage({ id, name: `${p.n} ${p.title}` });
    }
    // tldraw's own first page, while it is empty, gives way to the app's three
    for (const page of editor.getPages()) {
      if (PAGES.some((p) => pageIdOf(p.id) === page.id)) continue;
      if (editor.getSortedChildIdsForParent(page.id).length === 0 && editor.getPages().length > 1) {
        if (editor.getCurrentPageId() === page.id) editor.setCurrentPage(pageIdOf(PAGES[0].id));
        editor.deletePage(page.id);
      }
    }
    for (const [card, c] of Object.entries(CARDS)) {
      const id = cardIdOf(card);
      if (!editor.getShape(id)) editor.createShape({ id, type: CARD_SHAPE, parentId: pageIdOf(c.page), x: c.x, y: c.y, props: { w: c.w, h: c.h, card } });
    }
  }, { history: 'ignore' });
}

/** Every card of a page back where the app puts it. */
export function resetLayout(editor, page) {
  editor.run(() => {
    for (const c of cardsOf(page)) {
      const id = cardIdOf(c.id);
      if (editor.getShape(id)) editor.updateShape({ id, type: CARD_SHAPE, x: c.x, y: c.y, props: { w: c.w, h: c.h } });
    }
  });
  fitPage(editor, page, false);
}

/** Where a page's cards sit in the board's window: clear of tldraw's menu bar above and its toolbar below. */
export const FIT = Object.freeze({ left: 24, right: 24, top: 64, bottom: 76 });
/**
 * The camera on a page's cards: as wide as the window lets them be (at most 100 %), their top under tldraw's menu bar; a page
 * taller than the window is panned down by the person (the wheel, or the hand tool). (screen = (page + camera) × zoom)
 */
export function fitPage(editor, page, animate = true) {
  const boxes = cardsOf(page).filter((c) => c.fit !== false).map((c) => editor.getShapePageBounds(cardIdOf(c.id))).filter(Boolean);
  if (!boxes.length) return;
  frame(editor, Box.Common(boxes), animate);
}

/** One card in view (the camera on it, as wide as the window lets it be). */
export function showCardOnBoard(editor, card) {
  const b = editor.getShapePageBounds(cardIdOf(card));
  if (b) frame(editor, b, true);
}

function frame(editor, b, animate) {
  const vp = editor.getViewportScreenBounds();
  const zw = (vp.w - FIT.left - FIT.right) / b.w;
  const zh = (vp.h - FIT.top - FIT.bottom) / b.h;
  // the whole page when it fits at ≥ 80 % of its width's zoom; else its width (the person pans down)
  const z = Math.max(0.25, Math.min(1, zh >= zw * 0.8 ? Math.min(zw, zh) : zw));
  const x = (vp.w - b.w * z) / 2 / z - b.x;
  const y = FIT.top / z - b.y;
  editor.setCamera({ x, y, z }, animate ? { animation: { duration: 220 } } : undefined);
}

// tldraw's props, made once: a new array or object on a render makes tldraw build its store again (and, with a persistenceKey,
// load it from IndexedDB again: the board stayed on its loading screen when the page re-rendered)
const SHAPE_UTILS = [TimmyCardUtil];
const OVERRIDES = { actions: (_editor, actions) => { const { 'toggle-dark-mode': _dark, ...kept } = actions; return kept; } };
/**
 * tldraw's style panel only while the person draws: a drawing tool is chosen, or something they drew is selected (a card has no
 * style of its own, and the panel covered the cards beside it).
 */
function StylePanel(props) {
  const editor = useEditor();
  const shown = useValue('timmy app: style panel', () => editor.getCurrentToolId() !== 'select' || editor.getSelectedShapes().some((x) => x.type !== CARD_SHAPE), [editor]);
  return shown ? <DefaultStylePanel {...props} /> : null;
}
const COMPONENTS = { PageMenu: null, DebugMenu: null, DebugPanel: null, StylePanel };
let assetUrls = null;
let themes = null;

export const Board = memo(function Board({ licenseKey, onEditor }) {
  const page = useApp((s) => s.page);
  const editorRef = useRef(null);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const id = pageIdOf(page);
    if (editor.getCurrentPageId() !== id && editor.getPage(id)) editor.setCurrentPage(id);
    requestAnimationFrame(() => fitPage(editor, page));
  }, [page]);
  return (
    <Tldraw
      persistenceKey="timmy-app-2"
      licenseKey={licenseKey || undefined}
      shapeUtils={SHAPE_UTILS}
      assetUrls={assetUrls || (assetUrls = getAssetUrls({ baseUrl: `${location.origin}/app/dist/assets/` }))}
      themes={themes || (themes = timmyThemes(DEFAULT_THEME, cssVar))}
      colorScheme="dark"
      overrides={OVERRIDES}
      components={COMPONENTS}
      onMount={(editor) => {
        editorRef.current = editor;
        editor.user.updateUserPreferences({ colorScheme: 'dark' });
        ensureBoard(editor);
        // the cards are the app's parts: deleting the drawing never deletes a card (Reset layout puts them back where they were)
        editor.sideEffects.registerBeforeDeleteHandler('shape', (shape) => (shape.type === CARD_SHAPE ? false : undefined));
        const want = pageIdOf(getState().page);
        if (editor.getPage(want)) editor.setCurrentPage(want);
        fitPage(editor, getState().page, false);
        // the step path follows the board when the person changes page in tldraw (its keyboard shortcuts)
        const off = react('timmy app: page', () => {
          const current = editor.getCurrentPageId();
          const p = PAGES.find((x) => pageIdOf(x.id) === current);
          if (p && p.id !== getState().page) goTo(p.id);
        });
        window.timmyApp = { editor, fit: () => fitPage(editor, getState().page), reset: () => resetLayout(editor, getState().page), show: (card) => showCardOnBoard(editor, card) };
        if (onEditor) onEditor(editor);
        return () => { off(); };
      }}
    />
  );
});

