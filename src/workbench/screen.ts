/**
 * R4 (H110), R5 (H131): one frame of the Workbench: the zones laid out for the terminal's size (src/workbench/layout.ts), row 1
 * (TIMMY, the project, the ten tabs) and row 2 (the tab's workflow actions) from the workspace frame (src/workbench/hub.ts), the
 * body's columns and Activity & log from their views (src/workbench/views.ts), each list scrolled so its selected row shows,
 * every row exactly the terminal's width. It also says where each region's selectable rows, each tab and each action are, so a
 * click lands on what it is drawn over.
 */
import { tabOf } from '../contracts/workspace.js';
import { compose, innerWidth, panel, type Glyphs, type Placed } from './frame.js';
import { eventLogView, frameTabs, isHub, pipelineLines, previewView, tabBar, type PageHit } from './hub.js';
import { layoutFor, MIN_COLUMNS, MIN_ROWS, type Layout, type Rect } from './layout.js';
import type { Data, Region, Ui, View } from './model.js';
import { navItem } from './nav.js';
import { endOf, keepInView, scrollFor } from './select.js';
import { fit, type Line } from './text.js';
import { bottomView, centerView, cursorOf, navView, rightView, runWords, selectedItem, stopWords, topLines, type ViewCtx } from './views.js';

export interface RegionDraw {
  rect: Rect;
  /** the list the cursor keys move ("center:files") */
  list: string;
  items: View['items'];
  /** the view's first row shown */
  scroll: number;
  /** rows of the view not scrolled (the right dock's tabs) */
  fixed: number;
  /** R4 (H112): how many of the scrolled rows the zone shows, and how many there are (the wheel scrolls within them) */
  height: number;
  total: number;
}

export interface Frame {
  screen: Line[];
  layout: Layout;
  regions: Partial<Record<Region, RegionDraw>>;
  /** the right dock's tabs, by cell (for a click) */
  tabs: Array<{ x0: number; x1: number; y: number; tab: 'tools' | 'inspector' | 'files' }>;
  /** R5 (H131): row 1's tabs, by cell (a click opens one) */
  pages: PageHit[];
  /** R5 (H131): row 2's workflow actions, by cell (a click selects one; Enter runs it) */
  actions: Array<{ x0: number; x1: number; y: number; i: number }>;
}

export interface FrameAsk { ui: Ui; data: Data; g: Glyphs; columns: number; rows: number; now: number; can: ViewCtx['can'] }

/** The first row to show so that row `at` is in view, keeping the earlier rows where they fit (src/workbench/select.ts). */
export const scrollTo = (at: number | undefined, prev: number, height: number, total: number): number => keepInView(at, prev, height, total, undefined, at !== undefined && at < height);

const rangeNote = (scroll: number, height: number, total: number): string | undefined => (total > height ? `${scroll + 1}–${Math.min(total, scroll + height)} of ${total}` : undefined);

/** R5 (H131): the body's title: the project and the workspace (Home: its hub), as the crumb "project / workspace" was. */
export function bodyTitle(ui: Ui, data: Data): string {
  if (ui.page === 'home' && ui.workspace === 'connections') return `${data.project.name} / Home · connections, as observed`;
  return `${data.project.name} / ${navItem(ui.workspace).title}`;
}

export function frameOf(a: FrameAsk): Frame {
  const { ui, data, g } = a;
  const layout = layoutFor({
    columns: a.columns, rows: a.rows, body: isHub(ui.page) ? 'hub' : 'workspace', pipeline: ui.page === 'chat' && !ui.overlay,
    navOpen: ui.navOpen, rightOpen: ui.rightOpen, activityOpen: ui.activityOpen, focusMode: ui.focusMode === true,
  });
  const ctx = (r: Rect): ViewCtx => ({ ui, data, g, width: Math.max(1, innerWidth(r.w)), height: Math.max(1, r.h - 2), now: a.now, can: a.can, columns: a.columns });
  const placed: Placed[] = [];
  const regions: Frame['regions'] = {};
  const tabs: Frame['tabs'] = [];
  const actions: Frame['actions'] = [];

  // row 1: TIMMY, the project, the ten tabs (the frame's; the contract's until the frame is first read)
  const bar = tabBar(frameTabs(data.frame), ui.page, data.project.name, a.columns, layout.tabRows, g);
  placed.push({ rect: layout.tabs, rows: bar.lines.slice(0, layout.tabs.h).map((l) => fit(l, a.columns, g.ellipsis)) });
  const pages: PageHit[] = bar.hits.map((h) => ({ ...h, y0: layout.tabs.y + h.y0, y1: Math.min(layout.tabs.y + layout.tabs.h - 1, layout.tabs.y + h.y1) }));

  if (layout.tooSmall) {
    // too small for the zones: the facts that stay at every size, and why the rest is not drawn
    const stop = stopWords(data, selectedItem(ctx(layout.tabs)), ui.workspace);
    const lines: Line[] = [
      [{ text: `${data.project.name} / ${tabOf(ui.page).label} / ${navItem(ui.workspace).label}`, role: 'strong' }],
      [{ text: runWords(data), role: data.decisions.total ? 'attention' : 'secondary' }],
      stop.target ? [{ text: '[x]', role: 'action' }, { text: ` ${stop.text}`, role: 'strong' }] : [{ text: stop.text, role: 'secondary' }],
      [{ text: `The Workbench needs at least ${MIN_COLUMNS}×${MIN_ROWS}; this terminal is ${a.columns}×${a.rows}. Make it larger, or use timmy (the REPL). Ctrl+C quits.`, role: 'secondary' }],
    ];
    const top = layout.tabs.h;
    const screen = Array.from({ length: a.rows }, (_, i) => (i < top ? fit(bar.lines[i] ?? [], a.columns, g.ellipsis) : fit(lines[i - top] ?? [], a.columns, g.ellipsis)));
    return { screen, layout, regions, tabs, pages, actions };
  }

  // row 2: the workflow actions (the region 'top'), the run state and Stop
  {
    const c = ctx(layout.top);
    const t = topLines(c, layout.topDetail);
    const tab = tabOf(ui.page);
    placed.push({ rect: layout.top, rows: panel({ title: 'Workflow actions', lines: t.lines, focused: ui.focus === 'top', note: `${tab.key} ${tab.label}` }, layout.top, g) });
    regions.top = { rect: layout.top, list: 'top', items: [], scroll: 0, fixed: 0, height: 0, total: 0 };
    // where each button is drawn: inside the border and its one cell of air
    const x0 = layout.top.x + 1 + (layout.top.w - 2 >= 6 ? 1 : 0);
    for (const h of t.hits) actions.push({ x0: x0 + h.x0, x1: x0 + h.x1, y: layout.top.y + 1, i: h.i });
  }

  // the Chat tab's pipeline row, above its two columns
  if (layout.strip) {
    const c = ctx(layout.strip);
    placed.push({ rect: layout.strip, rows: panel({ title: 'Pipeline · intent → predict → sandbox → receipt', lines: pipelineLines(c, c.width), focused: false }, layout.strip, g) });
  }

  // the navigation drawer (its selection is the workspace shown)
  if (layout.nav) {
    const c = ctx(layout.nav);
    const v = navView(c);
    const active = v.items.findIndex((it) => it.item.kind === 'action' && it.item.action === ui.workspace);
    // while it searches, its prompt and the matches below it show (a short drawer would otherwise keep the shown workspace's
    // row in view and the typed words above it, out of sight)
    const searching = ui.input.field === 'search';
    const at = searching ? v.prompt : active >= 0 ? v.items[active].line : undefined;
    const scroll = scrollFor(ui, 'nav', v.items, { ...(at !== undefined ? { at } : {}), height: c.height, total: v.lines.length, first: searching || active === 0 });
    placed.push({ rect: layout.nav, rows: panel({ title: 'TIMMY', lines: v.lines.slice(scroll, scroll + c.height), focused: ui.focus === 'nav', footer: 'Esc closes' }, layout.nav, g) });
    regions.nav = { rect: layout.nav, list: 'nav', items: v.items, scroll, fixed: 0, height: c.height, total: v.lines.length };
  }

  // the body's left column: Home's cards, Chat's conversation, or the tab's workspace
  if (layout.center) {
    const c = ctx(layout.center);
    const v = centerView(c);
    const list = ui.overlay ? 'overlay' : `center:${ui.workspace}`;
    const i = v.items.length ? cursorOf(ui, list, v.items.length) : -1;
    const span = i >= 0 ? v.items[i].rows ?? 1 : 1;
    const scroll = scrollFor(ui, list, v.items, { ...(i >= 0 ? { at: v.items[i].line, ...(span > 1 ? { end: v.items[i].line + span - 1 } : {}) } : {}), height: c.height, total: v.lines.length, first: i === 0 });
    const title = ui.overlay ? overlayTitle(ui) : `${bodyTitle(ui, data)}${ui.focusMode ? ` ${g.sep} focus mode (z leaves it)` : ''}`;
    placed.push({ rect: layout.center, rows: panel({ title, lines: v.lines.slice(scroll, scroll + c.height), focused: ui.focus === 'center', ...(rangeNote(scroll, c.height, v.lines.length) ? { note: rangeNote(scroll, c.height, v.lines.length)! } : {}) }, layout.center, g) });
    regions.center = { rect: layout.center, list, items: v.items, scroll, fixed: 0, height: c.height, total: v.lines.length };
  }

  // the body's right column: Context (Tools, Inspector, Files), or Home's preview and Chat's event log
  if (layout.right && layout.rightAs === 'hub') {
    const c = ctx(layout.right);
    const home = ui.page === 'home';
    const v = home ? previewView(c) : eventLogView(c);
    const list = `right:hub-${ui.page}`;
    const scroll = scrollFor(ui, list, [], { height: c.height, total: v.lines.length });
    const title = home ? 'Preview · the companion and Studio, in words' : 'Event log · newest at the top';
    placed.push({ rect: layout.right, rows: panel({ title, lines: v.lines.slice(scroll, scroll + c.height), focused: ui.focus === 'right', ...(rangeNote(scroll, c.height, v.lines.length) ? { note: rangeNote(scroll, c.height, v.lines.length)! } : {}) }, layout.right, g) });
    regions.right = { rect: layout.right, list, items: [], scroll, fixed: 0, height: c.height, total: v.lines.length };
  } else if (layout.right) {
    const c = ctx(layout.right);
    const v = rightView(c);
    const list = `right:${ui.tab}`;
    const fixed = 2;
    const body = Math.max(1, c.height - fixed);
    const rest = v.lines.slice(fixed);
    const items = v.items.map((x) => ({ ...x, line: x.line - fixed }));
    const i = items.length ? cursorOf(ui, list, items.length) : -1;
    const scroll = scrollFor(ui, list, items, { ...(i >= 0 ? { at: items[i].line } : {}), height: body, total: rest.length, first: i === 0 });
    const lines = [...v.lines.slice(0, fixed), ...rest.slice(scroll, scroll + body)];
    const drawer = layout.rightAs === 'drawer';
    placed.push({ rect: layout.right, rows: panel({ title: drawer ? 'Context (drawer)' : 'Context', lines, focused: ui.focus === 'right', ...(drawer ? { footer: 'Esc closes' } : {}), ...(rangeNote(scroll, body, rest.length) ? { note: rangeNote(scroll, body, rest.length)! } : {}) }, layout.right, g) });
    regions.right = { rect: layout.right, list, items, scroll, fixed, height: body, total: rest.length };
    // where each tab's label is drawn on the tabs' row (inside the border and its one cell of air)
    let x = layout.right.x + 1 + (layout.right.w - 2 >= 6 ? 1 : 0);
    for (const seg of v.lines[0] ?? []) {
      const w = [...seg.text].length;
      const t = /Tools/.test(seg.text) ? 'tools' : /Inspector/.test(seg.text) ? 'inspector' : /Files/.test(seg.text) ? 'files' : null;
      if (t) tabs.push({ x0: x, x1: x + w - 1, y: layout.right.y + 1, tab: t });
      x += w;
    }
  }

  // Activity & log: its first rows stay; expanded, its events scroll (R4, H112: oldest first, the newest at the bottom, each
  // shown whole when it fits, the view following the newest only while the selection is the newest); the key-hint line last
  {
    const c = ctx(layout.bottom);
    const v = bottomView(c, { logLines: layout.logLines, stop: !layout.topDetail });
    const fixed = Math.min(v.fixed, v.lines.length);
    const body = Math.max(0, c.height - fixed - 1);
    const rest = v.lines.slice(fixed);
    const items = v.items.map((x) => ({ ...x, line: x.line - fixed }));
    const i = items.length ? cursorOf(ui, 'bottom', items.length) : -1;
    const scroll = scrollFor(ui, 'bottom', items, { ...(i >= 0 ? { at: items[i].line, end: endOf(items, i, rest.length) } : {}), height: Math.max(1, body), total: rest.length });
    const shown = rest.slice(scroll, scroll + body);
    const lines = [...v.lines.slice(0, fixed), ...shown, ...Array.from({ length: Math.max(0, body - shown.length) }, (): Line => []), v.foot];
    const note = ui.activityOpen ? rangeNote(scroll, Math.max(1, body), rest.length) : undefined;
    placed.push({ rect: layout.bottom, rows: panel({ title: 'Activity & log', lines, focused: ui.focus === 'bottom', ...(note ? { note } : {}) }, layout.bottom, g) });
    regions.bottom = { rect: layout.bottom, list: 'bottom', items, scroll, fixed, height: Math.max(1, body), total: rest.length };
  }

  return { screen: compose(layout, placed), layout, regions, tabs, pages, actions };
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
