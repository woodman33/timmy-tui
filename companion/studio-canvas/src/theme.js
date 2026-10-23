// R5 (H133): tldraw's own canvas colors on Timmy's palette (DESIGN.md §10 B10, the operator's decision of 2026-10-15): the
// canvas behind the drawing, the selection, the selection brush, snap lines, the laser, handles and the cursor. tldraw 5.5.2
// draws these from its theme's UI colors (its Themes guide: TLThemeUiColorKeys); its menus, toolbar and panels take theirs
// from CSS variables, which index.html sets from the same tokens.
//
// Content keeps its colors. tldraw's palette for what a person draws (black, blue, red ... with their fills, patterns, notes,
// frames and highlights), `solid` (the semi fill of shapes) and `noteBorder` stay exactly tldraw's: this module copies them
// through untouched, and a test holds it to that.
//
// Every value is read from Timmy's shared look (/timmy-theme.css, made from src/theme/tokens.ts) by its --timmy-* name; the hex
// beside each name is only its fallback (the value tokens.ts gives it), for a page whose theme sheet did not load.
// It imports nothing: canvas.js hands in tldraw's DEFAULT_THEME and a reader of the page's CSS variables, so the rules below
// run in Node's tests too.

/** The tokens this module reads: name → [CSS variable, fallback]. */
export const TOKENS = Object.freeze({
  ground: ['--timmy-ground', '#000000'],
  text: ['--timmy-text', '#F2EFE9'],
  accent: ['--timmy-accent', '#FFB000'],
  silver: ['--timmy-silver', '#E8E4D9'],
});

/** The UI colors of tldraw's theme that are chrome (TLThemeUiColorKeys minus `solid` and `noteBorder`, which draw shapes). */
export const CHROME_KEYS = Object.freeze(['text', 'background', 'negativeSpace', 'cursor', 'selectionStroke', 'selectionFill', 'selectedContrast', 'brushStroke', 'brushFill', 'snap', 'laser']);

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * `color` at `alpha` (0..1): #RRGGBBAA for a hex color (tldraw paints its overlays on a 2D canvas, which reads it), else a CSS
 * color-mix with transparent.
 */
export function withAlpha(color, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  const m = HEX.exec(String(color).trim());
  if (!m) return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`;
  const rgb = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return `#${rgb.toUpperCase()}${Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase()}`;
}

/**
 * tldraw's chrome colors on B10, from `read(variable, fallback)` (the page's CSS variables): the canvas and its knockouts black,
 * the selection, its brush and the laser amber (where to look and act), snap lines silver (secondary target geometry), handles
 * and the cursor off-white. Nothing here is green: a selection is never a verification.
 */
export function chromeColors(read) {
  const t = (name) => {
    const [variable, fallback] = TOKENS[name];
    const v = typeof read === 'function' ? read(variable, fallback) : '';
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
  };
  return {
    // the canvas (exports and the minimap use it; the page's canvas is --tl-color-background, set from the same token)
    background: t('ground'),
    // frame heading knockouts and text outlines cut through to the canvas
    negativeSpace: t('ground'),
    // the arrow binding hint and the black scribble
    text: t('text'),
    cursor: t('text'),
    selectionStroke: t('accent'),
    selectionFill: withAlpha(t('accent'), 0.16),
    // the fill of a selected shape's handles
    selectedContrast: t('text'),
    brushStroke: withAlpha(t('accent'), 0.55),
    brushFill: withAlpha(t('accent'), 0.08),
    snap: t('silver'),
    laser: t('accent'),
  };
}

/**
 * The themes to hand tldraw (its `themes` prop): tldraw's default theme with its dark palette's chrome colors on B10. The light
 * palette, every shape color, `solid` and `noteBorder` are tldraw's own, unchanged. Timmy Canvas is dark only (canvas.js keeps
 * the color scheme dark), so the light palette is never shown; it is kept whole because tldraw requires both.
 */
export function timmyThemes(defaultTheme, read) {
  const dark = defaultTheme.colors.dark;
  return {
    default: {
      ...defaultTheme,
      colors: { ...defaultTheme.colors, dark: { ...dark, ...chromeColors(read) } },
    },
  };
}
