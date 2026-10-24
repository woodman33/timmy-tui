/**
 * R5 (H131): where the Workbench's zones sit at a terminal's size, as the operator's reference layouts lay them out (codex-ui-
 * references 01, 02, 11, 12, 13, 14; the R5 order of 2026-10-15): from the top,
 *
 *   row 1     TIMMY, the project, the route and what runs and waits; then the grouped destinations (R11 round 7, H177:
 *             src/workbench/destinations.ts, the Chat screen's rail groups, the shown one amber; 1 row on a short terminal)
 *   row 2     the page head: its title and one-line description, the tab's numbered actions with the one primary next step
 *             amber, the selected step's words, the run state and Stop
 *   body      two columns: Home (connection cards | a preview) and Chat (transcript | event log, under its pipeline row) at
 *             ≈48% | ≈52% from 100 columns; every other tab its Workbench workspace with Context (Tools, Inspector, Files) as
 *             a column from 120 columns, a drawer below ([i]); R5 (H136): a body that draws its own columns (OWN_COLUMNS)
 *             takes the whole width at every size, Context a drawer ([i])
 *   bottom    Activity & log: its newest lines (3 to 5), [a] expands it; then the key-hint line
 *
 * The navigation (CREATE, OPERATE, LIBRARY) is a drawer at every size ([g], and [/] to find a workspace): the tabs are the
 * stable way around. Cells are counted from 0 at the top left. Pure arithmetic: the app draws what this returns, and a mouse
 * report is read against it.
 */
import type { WorkspaceId } from './nav.js';

/** The body's kind: a hub (Home, Chat) draws its own right column; a workspace tab has Context beside it; R5 (H136): a body
 *  that draws its own columns (OWN_COLUMNS) takes the whole width, Context a drawer ([i]). */
export type BodyKind = 'hub' | 'workspace' | 'columns';

/** R5 (H136; the lead, 2026-10-15): the workspaces whose body draws its own columns side by side (tab 3 Workflows: the plan,
 *  the sandbox and the run, the receipt and its review; R5 H137: tab 7 Control Room, the roster, the panes and what waits):
 *  one rule for every such body; another joins by its name here.
 *  R5 (H134): tab 0 Logs & Receipts, tab 8 Fleet & Clef, tab 5 VoxVision and tab 9 Tools & MCP, each with its own detail
 *  column beside its lists (src/workbench/logs-tab.ts, fleet-tab.ts, voxvision-tab.ts, tools-tab.ts). */
export const OWN_COLUMNS: ReadonlySet<WorkspaceId> = new Set<WorkspaceId>(['workflows', 'control', 'logs', 'fleet', 'voxvision', 'tools']);

/** The body's kind for the active tab (a hub or not) and the workspace it shows. */
export const bodyKind = (hub: boolean, ws: WorkspaceId): BodyKind => (hub ? 'hub' : OWN_COLUMNS.has(ws) ? 'columns' : 'workspace');

/** wide: a workspace tab's Context is a column; medium: a hub's two columns, Context a drawer; narrow: one column. */
export type Mode = 'wide' | 'medium' | 'narrow';

export interface Rect { x: number; y: number; w: number; h: number }

export interface Layout {
  columns: number;
  rows: number;
  mode: Mode;
  /** too small to draw the zones: only the project, the run state, Stop and why */
  tooSmall: boolean;
  /** row 1: TIMMY, the project and the tabs */
  tabs: Rect;
  /** row 1's height: 2 (R10 H167: the status row, then the tabs) or 1 (a short terminal) */
  tabRows: 1 | 2;
  /** row 2: the page head and the workflow actions (the region 'top') */
  top: Rect;
  /** whether row 2 has its detail row (the selected action, the run state and Stop): false on a short terminal, where the
   *  run state and Stop move to Activity's first row */
  topDetail: boolean;
  /** the Chat tab's pipeline row (intent → predict → run → receipt), above its two columns */
  strip: Rect | null;
  nav: Rect | null;
  /** R10 CHAT (H167): 'rail': the Chat screen's permanent left rail */
  navAs: 'drawer' | 'hidden' | 'rail';
  center: Rect | null;
  right: Rect | null;
  /** column: Context beside a workspace; drawer: Context opened over the body ([i]); hub: Home's preview or Chat's log;
   *  R10 CHAT (H167): models: the Chat screen's Models rail (beside the conversation, or its drawer where it does not fit) */
  rightAs: 'column' | 'drawer' | 'hub' | 'hidden' | 'models';
  bottom: Rect;
  /** how many of the log's newest lines the collapsed Activity & log shows */
  logLines: number;
  /** R10 (H167): the collapsed Activity & log shows no log line (Chat: its own column is the log), only a row a notice two rows
   *  long takes */
  quietLog?: boolean;
  /** how many event rows the expanded Activity & log shows */
  activityRows: number;
  /** R10 CHAT (H167): the Chat screen's shell (src/workbench/chat-shell.ts): the rail is `nav`, the header `tabs`, the
   *  conversation `center`, Models `right`, this conversation's controls `bottom` */
  shell?: 'chat';
  /** R10 CHAT (H167): Models is a drawer here (it does not fit beside the conversation); [M] opens and Esc closes it */
  modelsDrawer?: boolean;
}

/**
 * R10 CHAT (H167): the Chat screen's zones at this size, as the operator's terminal target lays them out in cells
 * (src/workbench/chat-shell.ts chatGrid draws them): the header rows 0-2 the whole width; the rail from row 3, 18 columns from
 * 110 columns (14 below) with its separator after it; the conversation and the composer between it and Models (31 columns
 * from 110, with a separator before them; below, Models is a drawer over the conversation, [M]); the bottom's three rows right
 * of the rail. Null where the screen is under the Workbench's minimum.
 */
export function chatLayout(a: { columns: number; rows: number; modelsOpen?: boolean }): Layout | null {
  const columns = Math.max(1, Math.floor(a.columns));
  const rows = Math.max(1, Math.floor(a.rows));
  if (columns < MIN_COLUMNS || rows < MIN_ROWS + 4) return null;
  const wide = columns >= 110;
  const railW = wide ? 18 : 14;
  const sepR = wide ? columns - 32 : null;
  const contentH = rows - 6;
  const centerX = railW + 1;
  const centerW = (sepR ?? columns) - centerX;
  const right: Rect | null = sepR !== null ? { x: sepR + 1, y: 3, w: columns - sepR - 1, h: contentH } : a.modelsOpen ? { x: centerX, y: 3, w: centerW, h: contentH } : null;
  return {
    columns, rows, mode: modeOf(columns), tooSmall: false, tabs: { x: 0, y: 0, w: columns, h: 3 }, tabRows: 2, top: { x: centerX, y: 3, w: centerW, h: 0 }, topDetail: true,
    strip: null, nav: { x: 0, y: 3, w: railW, h: rows - 3 }, navAs: 'rail', center: { x: centerX, y: 3, w: centerW, h: contentH },
    right, rightAs: right ? 'models' : 'hidden', bottom: { x: railW + 1, y: rows - 3, w: columns - railW - 1, h: 3 }, logLines: 0, quietLog: true,
    activityRows: 0, shell: 'chat', ...(right && sepR === null ? { modelsDrawer: true } : {}),
  };
}

/** From here a workspace tab has Context as a column (below: a drawer, [i]). */
export const WIDE = 120;
/** From here Home and Chat draw their two columns (below: one, Context a drawer). */
export const MEDIUM = 100;
export const MIN_COLUMNS = 60;
export const MIN_ROWS = 16;
/** From here the header is two rows (R10 H167: TIMMY, the project, the route and what runs and waits; then the tabs); below,
 *  one row of keys with the active label. */
export const TAB_BOX_ROWS = 20;
/** The navigation drawer's width. */
const NAV_W = 28;
/** Context as a drawer: its width, unless the body is narrower. */
const DRAWER_W = 40;
/** below this the center gives way to an open drawer entirely */
const CENTER_MIN = 30;
/** R10 (H167): Home's and Chat's left column's share of the width (recent work, the conversation) */
export const HUB_LEFT = 0.57;
/** the Chat tab's pipeline row: its border, its boxes and its words */
const STRIP_H = 4;

export const modeOf = (columns: number): Mode => (columns >= WIDE ? 'wide' : columns >= MEDIUM ? 'medium' : 'narrow');

/** Whether Context (Tools, Inspector, Files) is a column at this size for this body (else a drawer, [i]). */
export const contextIsColumn = (columns: number, body: BodyKind, focusMode = false): boolean => body === 'workspace' && !focusMode && columns >= WIDE;

export interface LayoutAsk {
  columns: number;
  rows: number;
  /** the active tab's body */
  body?: BodyKind;
  /** the Chat tab: its pipeline row above the two columns */
  pipeline?: boolean;
  /** the navigation drawer is open */
  navOpen?: boolean;
  /** Context's drawer is open (where Context is not a column) */
  rightOpen?: boolean;
  /** Activity & log is expanded */
  activityOpen?: boolean;
  /** focus mode: the body's left column alone; the navigation and Context open only as drawers */
  focusMode?: boolean;
  /** R10 (H167; H168's F9): Activity & log collapsed to its strip (and the hints) where the body draws the log itself (Chat) */
  quietLog?: boolean;
}

export function layoutFor(a: LayoutAsk): Layout {
  const columns = Math.max(1, Math.floor(a.columns));
  const rows = Math.max(1, Math.floor(a.rows));
  const mode = modeOf(columns);
  const body = a.body ?? 'workspace';
  const tooSmall = columns < MIN_COLUMNS || rows < MIN_ROWS;
  // (R10 H167; H168's F8: the status row, with the route, from 20 rows: at 80x24 too; below, one row of keys)
  const tabRows: 1 | 2 = rows >= TAB_BOX_ROWS ? 2 : 1;
  const topDetail = rows >= 24;
  // (R11 round 7, H177: the head's description row above the actions, at every height)
  const topH = (topDetail ? 4 : 3) + 1;
  // (under 30 rows the status row takes the row a log line had, so the body keeps every row it had: at 80x24 a workspace's
  // list shows 11 rows, as before the status row was there. R11 round 7, H177: under 25 rows the page head's description
  // row takes the last log line's: the quiet records are Activity's own row there, which says the newest event ("last: …")
  // and expands with [a])
  const logLines = a.quietLog ? 0 : rows >= 40 ? 4 : rows >= 30 ? 3 : rows >= 28 ? 2 : rows >= 25 ? 1 : 0;
  // (and Activity & log expanded gives it one event row under 30 rows, for the same reason)
  const activityRows = Math.max(2, Math.min(8, Math.floor(rows / 4)) - (tabRows === 2 && rows < 30 ? 1 : 0));
  const tabs: Rect = { x: 0, y: 0, w: columns, h: Math.min(rows, tabRows) };
  if (tooSmall) {
    return {
      columns, rows, mode, tooSmall, tabs, tabRows, top: { x: 0, y: tabs.h, w: columns, h: 0 }, topDetail, strip: null, nav: null, navAs: 'hidden',
      center: null, right: null, rightAs: 'hidden', bottom: { x: 0, y: rows, w: columns, h: 0 }, logLines, activityRows,
    };
  }
  const top: Rect = { x: 0, y: tabs.h, w: columns, h: topH };
  // (R10 H167: a quiet log keeps one row under its strip for a notice two rows long, which takes it for its few seconds; empty
  // otherwise, never the log's lines again)
  const bottomH = a.activityOpen ? 5 + activityRows : 4 + logLines + (a.quietLog ? 1 : 0);
  const bodyY = top.y + top.h;
  const bodyH = Math.max(3, rows - bodyY - bottomH);
  const bottom: Rect = { x: 0, y: bodyY + bodyH, w: columns, h: rows - bodyY - bodyH };
  // the Chat tab's pipeline row, above its columns, where there is room for it and the columns under it
  const strip = a.pipeline && bodyH >= STRIP_H + 6 ? { x: 0, y: bodyY, w: columns, h: STRIP_H } : null;
  const colY = strip ? bodyY + STRIP_H : bodyY;
  const colH = strip ? bodyH - STRIP_H : bodyH;
  // the navigation is a drawer at every size: over the body's left, one drawer at a time
  const navAs: Layout['navAs'] = a.navOpen ? 'drawer' : 'hidden';
  const nav = navAs === 'drawer' ? { x: 0, y: colY, w: Math.min(NAV_W, columns), h: colH } : null;
  const mainX = nav ? nav.w : 0;
  const mainW = columns - mainX;
  let center: Rect | null = { x: mainX, y: colY, w: mainW, h: colH };
  let right: Rect | null = null;
  let rightAs: Layout['rightAs'] = 'hidden';
  const split = (rw: number): void => {
    if (mainW - rw < CENTER_MIN) { right = { x: mainX, y: colY, w: mainW, h: colH }; center = null; return; }
    right = { x: mainX + mainW - rw, y: colY, w: rw, h: colH };
    center = { x: mainX, y: colY, w: mainW - rw, h: colH };
  };
  if (!nav) {
    if (body === 'hub' && !a.focusMode && columns >= MEDIUM) {
      // Home and Chat: R10 (H167) ≈57% | ≈43%, the work (recent work, the conversation) the larger, as reference 02's direct
      // column (58%); Context opened ([i]) takes the right column's place, as a drawer
      split(columns - Math.round(columns * HUB_LEFT));
      rightAs = a.rightOpen ? 'drawer' : 'hub';
    } else if (contextIsColumn(columns, body, a.focusMode)) {
      // a workspace and Context beside it: the list keeps the room a row of it needs
      split(Math.max(DRAWER_W, Math.min(72, Math.round(columns * 0.38))));
      rightAs = 'column';
    } else if (a.rightOpen) {
      split(Math.min(DRAWER_W, mainW));
      rightAs = 'drawer';
    }
  }
  return { columns, rows, mode, tooSmall, tabs, tabRows, top, topDetail, strip, nav, navAs, center, right, rightAs, bottom, logLines, ...(a.quietLog ? { quietLog: true } : {}), activityRows };
}

/** The zone a cell is in, for the mouse (0-based cells). */
export function zoneAt(l: Layout, x: number, y: number): 'tabs' | 'nav' | 'top' | 'center' | 'right' | 'bottom' | null {
  const inside = (r: Rect | null): boolean => !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  if (inside(l.tabs)) return 'tabs';
  if (inside(l.nav)) return 'nav';
  if (inside(l.top)) return 'top';
  if (inside(l.center)) return 'center';
  if (inside(l.right)) return 'right';
  if (inside(l.bottom)) return 'bottom';
  return null;
}
