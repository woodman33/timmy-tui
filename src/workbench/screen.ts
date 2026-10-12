/**
 * R4 (H110): one frame of the Workbench: the zones laid out for the terminal's size (src/workbench/layout.ts), each zone's
 * rows from its view (src/workbench/views.ts), each list scrolled so its selected row shows, every row exactly the
 * terminal's width. It also says where each region's selectable rows are, so a click lands on what it is drawn over.
 */
import { compose, innerWidth, panel, type Glyphs, type Placed } from './frame.js';
import { layoutFor, MIN_COLUMNS, MIN_ROWS, type Layout, type Rect } from './layout.js';
import type { Data, Region, Ui, View } from './model.js';
import { navItem } from './nav.js';
import { fit, type Line } from './text.js';
import { bottomView, centerView, cursorOf, navView, rightView, runWords, stopWords, topLines, type ViewCtx } from './views.js';

export interface RegionDraw {
  rect: Rect;
  /** the list the cursor keys move ("center:files") */
  list: string;
  items: View['items'];
  /** the view's first row shown */
  scroll: number;
  /** rows of the view not scrolled (the right dock's tabs) */
  fixed: number;
}

export interface Frame {
  screen: Line[];
  layout: Layout;
  regions: Partial<Record<Region, RegionDraw>>;
  /** the right dock's tabs, by cell (for a click) */
  tabs: Array<{ x0: number; x1: number; y: number; tab: 'tools' | 'inspector' | 'files' }>;
}

export interface FrameAsk { ui: Ui; data: Data; g: Glyphs; columns: number; rows: number; now: number; can: ViewCtx['can'] }

/** The first row to show so that row `at` is in view, keeping the earlier rows where they fit. */
export function scrollTo(at: number | undefined, prev: number, height: number, total: number): number {
  const max = Math.max(0, total - height);
  if (at === undefined) return Math.min(Math.max(0, prev), max);
  let s = Math.min(Math.max(0, prev), max);
  if (at < s) s = at;
  if (at >= s + height) s = at - height + 1;
  // the first selectable row of a list: show what is above it too
  if (at < height) s = Math.min(s, 0);
  return Math.min(Math.max(0, s), max);
}

const rangeNote = (scroll: number, height: number, total: number): string | undefined => (total > height ? `${scroll + 1}–${Math.min(total, scroll + height)} of ${total}` : undefined);

export function frameOf(a: FrameAsk): Frame {
  const { ui, data, g } = a;
  const layout = layoutFor({ columns: a.columns, rows: a.rows, navOpen: ui.navOpen, rightOpen: ui.rightOpen, activityRows: ui.activityOpen ? 8 : 0, focusMode: ui.focusMode === true });
  const ctx = (r: Rect): ViewCtx => ({ ui, data, g, width: Math.max(1, innerWidth(r.w)), height: Math.max(1, r.h - 2), now: a.now, can: a.can });
  const placed: Placed[] = [];
  const regions: Frame['regions'] = {};
  const tabs: Frame['tabs'] = [];

  if (layout.tooSmall) {
    // too small for the zones: the facts that stay at every size, and why the rest is not drawn
    const stop = stopWords(data);
    const lines: Line[] = [
      [{ text: `${data.project.name} / ${navItem(ui.workspace).label}`, role: 'strong' }],
      [{ text: runWords(data), role: data.decisions.total ? 'attention' : 'secondary' }],
      stop.target ? [{ text: '[x]', role: 'action' }, { text: ` ${stop.text}`, role: 'strong' }] : [{ text: stop.text, role: 'secondary' }],
      [{ text: `The Workbench needs at least ${MIN_COLUMNS}×${MIN_ROWS}; this terminal is ${a.columns}×${a.rows}. Make it larger, or use timmy (the REPL). Ctrl+C quits.`, role: 'secondary' }],
    ];
    return { screen: Array.from({ length: a.rows }, (_, i) => fit(lines[i] ?? [], a.columns, g.ellipsis)), layout, regions, tabs };
  }

  // the navigation
  if (layout.nav) {
    const c = ctx(layout.nav);
    const v = navView(c);
    const active = v.items.findIndex((it) => it.item.kind === 'action' && it.item.action === ui.workspace);
    const at = active >= 0 ? v.items[active].line : undefined;
    const scroll = scrollTo(at, ui.scroll.nav ?? 0, c.height, v.lines.length);
    placed.push({ rect: layout.nav, rows: panel({ title: 'TIMMY', lines: v.lines.slice(scroll, scroll + c.height), focused: ui.focus === 'nav', ...(layout.navAs === 'drawer' ? { footer: 'Esc closes' } : {}) }, layout.nav, g) });
    regions.nav = { rect: layout.nav, list: 'nav', items: v.items, scroll, fixed: 0 };
  }

  // the top: project, task, state and Stop
  {
    const c = ctx(layout.top);
    placed.push({ rect: layout.top, rows: panel({ title: 'Timmy Workbench', lines: topLines(c), focused: ui.focus === 'top' }, layout.top, g) });
    regions.top = { rect: layout.top, list: 'top', items: [], scroll: 0, fixed: 0 };
  }

  // the center
  if (layout.center) {
    const c = ctx(layout.center);
    const v = centerView(c);
    const list = ui.overlay ? 'overlay' : `center:${ui.workspace}`;
    const cur = v.items.length ? v.items[cursorOf(ui, list, v.items.length)].line : undefined;
    const scroll = scrollTo(cur, ui.scroll[list] ?? 0, c.height, v.lines.length);
    const title = ui.overlay ? overlayTitle(ui) : `${navItem(ui.workspace).title}${ui.focusMode ? ` ${g.sep} focus mode (z leaves it)` : ''}`;
    placed.push({ rect: layout.center, rows: panel({ title, lines: v.lines.slice(scroll, scroll + c.height), focused: ui.focus === 'center', ...(rangeNote(scroll, c.height, v.lines.length) ? { note: rangeNote(scroll, c.height, v.lines.length)! } : {}) }, layout.center, g) });
    regions.center = { rect: layout.center, list, items: v.items, scroll, fixed: 0 };
  }

  // the right dock: its tabs stay; its rows scroll
  if (layout.right) {
    const c = ctx(layout.right);
    const v = rightView(c);
    const list = `right:${ui.tab}`;
    const fixed = 2;
    const body = Math.max(1, c.height - fixed);
    const rest = v.lines.slice(fixed);
    const cur = v.items.length ? v.items[cursorOf(ui, list, v.items.length)].line - fixed : undefined;
    const scroll = scrollTo(cur, ui.scroll[list] ?? 0, body, rest.length);
    const lines = [...v.lines.slice(0, fixed), ...rest.slice(scroll, scroll + body)];
    const drawer = layout.rightAs === 'drawer';
    placed.push({ rect: layout.right, rows: panel({ title: drawer ? 'Context (drawer)' : 'Context', lines, focused: ui.focus === 'right', ...(drawer ? { footer: 'Esc closes' } : {}), ...(rangeNote(scroll, body, rest.length) ? { note: rangeNote(scroll, body, rest.length)! } : {}) }, layout.right, g) });
    regions.right = { rect: layout.right, list, items: v.items.map((x) => ({ ...x, line: x.line - fixed })), scroll, fixed };
    // where each tab's label is drawn on the tabs' row (inside the border and its one cell of air)
    let x = layout.right.x + 1 + (layout.right.w - 2 >= 6 ? 1 : 0);
    for (const seg of v.lines[0] ?? []) {
      const w = [...seg.text].length;
      const t = /Tools/.test(seg.text) ? 'tools' : /Inspector/.test(seg.text) ? 'inspector' : /Files/.test(seg.text) ? 'files' : null;
      if (t) tabs.push({ x0: x, x1: x + w - 1, y: layout.right.y + 1, tab: t });
      x += w;
    }
  }

  // the bottom: task controls and Activity (its events scroll)
  {
    const c = ctx(layout.bottom);
    const v = bottomView(c);
    const fixed = ui.activityOpen ? 3 : 2;
    const body = Math.max(0, c.height - fixed);
    const rest = v.lines.slice(fixed);
    const cur = v.items.length ? v.items[cursorOf(ui, 'bottom', v.items.length)].line - fixed : undefined;
    const scroll = scrollTo(cur, ui.scroll.bottom ?? 0, Math.max(1, body), rest.length);
    const lines = [...v.lines.slice(0, fixed), ...rest.slice(scroll, scroll + body)];
    placed.push({ rect: layout.bottom, rows: panel({ title: navItem(ui.workspace).task, lines, focused: ui.focus === 'bottom' }, layout.bottom, g) });
    regions.bottom = { rect: layout.bottom, list: 'bottom', items: v.items.map((x) => ({ ...x, line: x.line - fixed })), scroll, fixed };
  }

  return { screen: compose(layout, placed), layout, regions, tabs };
}

function overlayTitle(ui: Ui): string {
  const o = ui.overlay;
  if (!o) return '';
  switch (o.kind) {
    case 'help': return 'Keys';
    case 'picker': return 'Switch project';
    case 'new': return 'New project';
    case 'settings': return 'Quick settings';
    case 'confirm-run': return 'Run a workflow block';
    case 'needs-you': return 'NEEDS YOU';
    case 'quit': return 'Quit';
    case 'message': return o.title;
    default: return '';
  }
}
