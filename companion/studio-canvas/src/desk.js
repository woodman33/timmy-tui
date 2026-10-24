// R11 round 7 (H176): the bounded desk, the Card Lab's canvas behaviour adapted for Timmy Studio (the operator's order of
// 2026-10-24: "Adapt its visual primitives and canvas behavior"; the reference's bar: Arrange · hand · zoom % · Fit workspace,
// and its line "A bounded desk. Zoom for detail; Fit to return."). The Card Lab's desk is a fixed finite surface per page; a
// Timmy board grows as people and Timmy place things on it, so here the desk is the page's content with a margin, drawn behind
// the shapes (tldraw's OnTheCanvas slot: a quiet edge, four corner marks, its caption), and nothing constrains the camera but
// the zoom's bounds (ZOOM_STEPS: 10 % … 200 %, tldraw's own stepping). The bar sits in tldraw's NavigationPanel slot (bottom
// left; tldraw's zoom menu and minimap are not drawn): Arrange and Pan are tldraw's select and hand tools, pressed as the
// toolbar shows them; zoom out · the level · zoom in are tldraw's own steps; Fit the board is canvas.js's fitBeside (the whole
// desk beside Timmy's panel, never closer than 100 %). Imports nothing: canvas.js hands in React and tldraw's hooks, so the
// rules below (deskOf, zoomWords, canZoom) run in Node's tests too.

/** The room the desk keeps around the page's content, in page units. */
export const DESK_MARGIN = 64;
/** The zoom levels the bar steps through (tldraw's cameraOptions.zoomSteps): bounded, 10 % to 200 %. */
export const ZOOM_STEPS = Object.freeze([0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]);
/** The desk's one line, as the reference says it. */
export const DESK_NOTE = 'A bounded desk. Zoom for detail; Fit to return.';

/** The desk around content bounds `b` ({ minX, minY, maxX, maxY } or { x, y, w, h }), or null for an empty page. */
export function deskOf(b, margin = DESK_MARGIN) {
  if (!b) return null;
  const minX = Number.isFinite(b.minX) ? b.minX : Number(b.x);
  const minY = Number.isFinite(b.minY) ? b.minY : Number(b.y);
  const maxX = Number.isFinite(b.maxX) ? b.maxX : minX + Number(b.w);
  const maxY = Number.isFinite(b.maxY) ? b.maxY : minY + Number(b.h);
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX < minX || maxY < minY) return null;
  return { x: Math.floor(minX - margin), y: Math.floor(minY - margin), w: Math.ceil(maxX - minX + 2 * margin), h: Math.ceil(maxY - minY + 2 * margin) };
}

/** The zoom level in words: "100 %". */
export const zoomWords = (z) => `${Math.round((Number(z) || 0) * 100)} %`;

/** Whether the bar can zoom out and in from level `z` within ZOOM_STEPS. */
export function canZoom(z, steps = ZOOM_STEPS) {
  const level = Number(z) || 1;
  return { out: level > steps[0] + 0.001, in: level < steps[steps.length - 1] - 0.001 };
}

/** The desk's caption: the project and the page ("tray · Houdini handoff"), or the page alone. */
export const captionOf = (project, page) => [project, page].filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim()).join(' · ');

/**
 * The two React parts. `deps`: React, useEditor, useValue (tldraw's), fit(editor) (canvas.js fitBeside), project() (the shown
 * project's name, or null), note(words) (the band, for a refused fit).
 */
export function createDesk(deps) {
  const { React, useEditor, useValue } = deps;
  const h = React.createElement;

  /** Behind the shapes: the desk's edge, corners and caption around the page's content; nothing on an empty page. */
  function Desk() {
    const editor = useEditor();
    const desk = useValue('timmy: the desk', () => deskOf(editor.getCurrentPageBounds()), [editor]);
    const page = useValue('timmy: the desk caption', () => editor.getCurrentPage().name, [editor]);
    if (!desk) return null;
    return h('div', { className: 'timmy-desk', 'aria-hidden': 'true', 'data-desk': `${desk.w}x${desk.h}`, style: { left: `${desk.x}px`, top: `${desk.y}px`, width: `${desk.w}px`, height: `${desk.h}px` } },
      h('span', { className: 'timmy-desk-caption' }, captionOf(deps.project ? deps.project() : null, page)),
      h('i', { className: 'timmy-desk-corner is-tl' }), h('i', { className: 'timmy-desk-corner is-tr' }), h('i', { className: 'timmy-desk-corner is-bl' }), h('i', { className: 'timmy-desk-corner is-br' }));
  }

  /** The bar: Arrange · Pan · zoom out · level · zoom in · Fit the board, and the desk's line beside it on a wide window. */
  function DeskBar() {
    const editor = useEditor();
    const tool = useValue('timmy: the desk tool', () => editor.getCurrentToolId(), [editor]);
    const zoom = useValue('timmy: the desk zoom', () => editor.getZoomLevel(), [editor]);
    const empty = useValue('timmy: the desk is empty', () => editor.getCurrentPageShapeIds().size === 0, [editor]);
    const can = canZoom(zoom);
    const button = (props, ...kids) => h('button', { type: 'button', ...props }, ...kids);
    return h('div', { className: 'timmy-desk-dock' },
      h('div', { className: 'timmy-desk-bar', role: 'toolbar', 'aria-label': 'The desk: arrange, pan, zoom and fit' },
        button({ 'aria-pressed': tool === 'select', title: 'Arrange: select and move what is on the board (V)', onClick: () => editor.setCurrentTool('select') }, '⌖ ', h('span', { className: 'timmy-desk-word' }, 'Arrange')),
        button({ 'aria-pressed': tool === 'hand', title: 'Pan: move around the board (H)', onClick: () => editor.setCurrentTool('hand') }, '✋ ', h('span', { className: 'timmy-desk-word' }, 'Pan')),
        h('span', { className: 'timmy-desk-sep', 'aria-hidden': 'true' }),
        button({ 'aria-label': 'Zoom out', title: 'Zoom out', disabled: !can.out, onClick: () => editor.zoomOut(editor.getViewportScreenCenter(), { animation: { duration: 160 } }) }, '−'),
        h('output', { className: 'timmy-desk-zoom', 'aria-label': 'Zoom level', 'aria-live': 'off' }, zoomWords(zoom)),
        button({ 'aria-label': 'Zoom in', title: 'Zoom in', disabled: !can.in, onClick: () => editor.zoomIn(editor.getViewportScreenCenter(), { animation: { duration: 160 } }) }, '+'),
        h('span', { className: 'timmy-desk-sep', 'aria-hidden': 'true' }),
        button({ className: 'timmy-desk-fit', title: 'Fit the board: the whole desk beside the panel, never closer than 100 %', disabled: empty, onClick: () => deps.fit(editor) }, '⛶ ', h('span', { className: 'timmy-desk-word' }, 'Fit the board'))),
      h('p', { className: 'timmy-desk-note' }, DESK_NOTE));
  }

  return { Desk, DeskBar };
}
