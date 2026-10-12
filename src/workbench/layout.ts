/**
 * R4 (H110): where the five zones sit at a terminal's size (the operator's reference, 2026-10-11: "at laptop widths, collapse
 * the inspector into an accessible drawer before shrinking the central work into a sliver; on small screens, navigation and
 * inspector become separate drawers"):
 *
 *   160 columns and more   all five zones: navigation | top over center and the right dock | bottom
 *   110 to 159             the right dock is a drawer ([i]): shown beside the center when open
 *   under 110              the navigation is a drawer too ([g]); one drawer at a time
 *
 * The top (project, task, state and Stop) and the bottom (task controls and Activity) are there at every size. Cells are
 * counted from 0 at the top left. Pure arithmetic: the app draws what this returns, and a mouse report is read against it.
 */

export type Mode = 'wide' | 'medium' | 'narrow';

export interface Rect { x: number; y: number; w: number; h: number }

export interface Layout {
  columns: number;
  rows: number;
  mode: Mode;
  /** too small to draw the zones: only the top's facts and why */
  tooSmall: boolean;
  nav: Rect | null;
  navAs: 'column' | 'drawer' | 'hidden';
  top: Rect;
  center: Rect | null;
  right: Rect | null;
  rightAs: 'column' | 'drawer' | 'hidden';
  bottom: Rect;
}

export const WIDE = 160;
export const MEDIUM = 110;
export const MIN_COLUMNS = 60;
export const MIN_ROWS = 16;
const NAV_W = { wide: 26, medium: 24, narrow: 26 } as const;
const RIGHT_W = { wide: 40, medium: 36, narrow: 34 } as const;
/** below this the center gives way to an open drawer entirely */
const CENTER_MIN = 30;

export const modeOf = (columns: number): Mode => (columns >= WIDE ? 'wide' : columns >= MEDIUM ? 'medium' : 'narrow');

export interface LayoutAsk {
  columns: number;
  rows: number;
  /** the navigation drawer is open (only under 110 columns) */
  navOpen?: boolean;
  /** the right dock's drawer is open (under 160 columns) */
  rightOpen?: boolean;
  /** Activity is expanded, with this many rows of events to show (at most a quarter of the screen) */
  activityRows?: number;
}

export function layoutFor(a: LayoutAsk): Layout {
  const columns = Math.max(1, Math.floor(a.columns));
  const rows = Math.max(1, Math.floor(a.rows));
  const mode = modeOf(columns);
  const tooSmall = columns < MIN_COLUMNS || rows < MIN_ROWS;
  const topH = rows >= 30 ? 5 : 4;
  if (tooSmall) {
    return { columns, rows, mode, tooSmall, nav: null, navAs: 'hidden', top: { x: 0, y: 0, w: columns, h: Math.min(rows, topH) }, center: null, right: null, rightAs: 'hidden', bottom: { x: 0, y: Math.min(rows, topH), w: columns, h: Math.max(0, rows - topH) } };
  }
  const navAs: Layout['navAs'] = mode === 'narrow' ? (a.navOpen ? 'drawer' : 'hidden') : 'column';
  // one drawer at a time when narrow: the navigation's wins
  const rightAs: Layout['rightAs'] = mode === 'wide' ? 'column' : a.rightOpen && navAs !== 'drawer' ? 'drawer' : 'hidden';
  const navW = navAs === 'hidden' ? 0 : NAV_W[mode];
  const nav = navAs === 'hidden' ? null : { x: 0, y: 0, w: navW, h: rows };
  const mainX = navW;
  const mainW = columns - navW;
  const extra = Math.max(0, Math.min(a.activityRows ?? 0, Math.floor(rows / 4)));
  const bottomH = 4 + extra;
  const top: Rect = { x: mainX, y: 0, w: mainW, h: topH };
  const midY = topH;
  const midH = Math.max(3, rows - topH - bottomH);
  const bottom: Rect = { x: mainX, y: midY + midH, w: mainW, h: rows - midY - midH };
  let right: Rect | null = null;
  let center: Rect | null = { x: mainX, y: midY, w: mainW, h: midH };
  if (rightAs !== 'hidden') {
    const rw = Math.min(RIGHT_W[mode], mainW);
    if (mainW - rw < CENTER_MIN) { right = { x: mainX, y: midY, w: mainW, h: midH }; center = null; }
    else { right = { x: mainX + mainW - rw, y: midY, w: rw, h: midH }; center = { x: mainX, y: midY, w: mainW - rw, h: midH }; }
  }
  return { columns, rows, mode, tooSmall, nav, navAs, top, center, right, rightAs, bottom };
}

/** The zone a cell is in, for the mouse (0-based cells). */
export function zoneAt(l: Layout, x: number, y: number): 'nav' | 'top' | 'center' | 'right' | 'bottom' | null {
  const inside = (r: Rect | null): boolean => !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  if (inside(l.nav)) return 'nav';
  if (inside(l.top)) return 'top';
  if (inside(l.center)) return 'center';
  if (inside(l.right)) return 'right';
  if (inside(l.bottom)) return 'bottom';
  return null;
}
