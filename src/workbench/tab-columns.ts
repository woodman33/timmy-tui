/**
 * R5 (H134): the parts the bodies of tab 0 (Logs & Receipts, src/workbench/logs-tab.ts) and tab 8 (Fleet & Clef,
 * src/workbench/fleet-tab.ts) are laid out with, as the operator's references lay theirs out (codex-ui-references 09, 10, 18):
 * columns side by side inside the body, titled boxes (cards), and a window over a column's blocks that keeps the selected
 * one in that column's own rows. Pure: rows in, rows out, every row exactly the width it is given (src/workbench/text.ts fit:
 * what does not fit ends in an ellipsis, never wraps through a border).
 */
import type { View } from './model.js';
import { boxOf, type Glyphs } from './frame.js';
import { cells, cut, fit, lineCells, wrapSegs, wrapText, type Line, type Role, type Seg } from './text.js';

export const S = (text: string, role: Role = 'text', o: Omit<Seg, 'text' | 'role'> = {}): Seg => ({ text, role, ...o });

/** A heading: the references' panel titles, uppercase and quiet. */
export const heading = (text: string): Seg => S(text.toUpperCase(), 'secondary', { bold: true });

/** The terminal width from which the bodies draw their columns side by side (src/workbench/layout.ts WIDE): below it they stack. */
export const COLUMNS_FROM = 120;
/** The body's narrowest width for columns side by side: the body beside Context at 120 columns is 70 cells wide. */
export const COLUMNS_MIN_WIDTH = 66;

/** What a tab body is drawn with: ViewCtx's parts it reads, and the terminal's width when the caller knows it. */
export interface TabCtx {
  ui: { cursor: Record<string, number> };
  g: Glyphs;
  /** the body's inner width */
  width: number;
  /** the body's inner height */
  height: number;
  now: number;
  /** the terminal's width: the columns sit side by side from COLUMNS_FROM; absent, the body's own width decides */
  columns?: number;
}

/** Whether the body draws its columns side by side: from 120 terminal columns (and room for them), else stacked. */
export const sideBySideAt = (c: Pick<TabCtx, 'width' | 'columns'>): boolean =>
  c.width >= COLUMNS_MIN_WIDTH && (c.columns === undefined || c.columns >= COLUMNS_FROM);

/** The View shape the other views return, over this body's own items (src/workbench/model.ts View, once wired). */
export interface TabView<I> { lines: Line[]; items: Array<{ line: number; item: I; rows?: number }>; note?: string }

// keep the shape in step with View: a TabView of View's own items is a View
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const SAME_AS_VIEW: Same<TabView<View['items'][number]['item']>, View> = true;

/** The selected item's place in a list of `n` (the list's cursor, kept inside it). */
export const selectedIn = (ui: TabCtx['ui'], list: string, n: number): number => (n ? Math.max(0, Math.min(n - 1, ui.cursor[list] ?? 0)) : -1);

/**
 * Which blocks show in `room` rows (`heights`: each block's rows): from the first while they fit, unless the selected one
 * (`sel`, -1 for none) would not show; then it is the last one shown, and the blocks before it fill what is left.
 */
export function windowBlocks(heights: readonly number[], sel: number, room: number): { start: number; end: number } {
  const n = heights.length;
  if (!n || room <= 0) return { start: 0, end: 0 };
  let start = 0;
  if (sel >= 0 && sel < n) {
    let used = 0;
    for (let i = 0; i <= sel; i++) used += heights[i];
    // the selected one at the bottom: move the start down until the rows up to it fit
    while (used > room && start < sel) { used -= heights[start]; start += 1; }
  }
  let end = start;
  let used = 0;
  while (end < n && used + heights[end] <= room) { used += heights[end]; end += 1; }
  // a block taller than the room still shows (cut at the room's end) rather than nothing
  if (end === start) end = Math.min(n, start + 1);
  return { start, end };
}

/**
 * windowBlocks, with a row kept for a mark above (`↑ n more above`) when the window does not start at the first block, and
 * one below (`↓ n more below`) when it does not reach the last: the marks are part of the room.
 */
export function windowMarked(heights: readonly number[], sel: number, room: number, g: Glyphs, w: number): { start: number; end: number; above: Line | null; below: Line | null } {
  let win = windowBlocks(heights, sel, room);
  let top = win.start > 0 ? 1 : 0;
  let bottom = 0;
  for (let k = 0; k < 3; k++) {
    win = windowBlocks(heights, sel, Math.max(1, room - top - bottom));
    const t = win.start > 0 ? 1 : 0;
    const b = win.end < heights.length ? 1 : 0;
    if (t === top && b === bottom) break;
    top = t;
    bottom = b;
  }
  const rows = (from: number, to: number): number => heights.slice(from, to).reduce((a, h) => a + h, 0);
  // which rows show, as the screen says it of a clipped body (src/workbench/screen.ts rangeNote): "a–b of n", on the last mark
  const range = `${rows(0, win.start) + 1}–${rows(0, win.end)} of ${rows(0, heights.length)} rows`;
  const hasBelow = win.end < heights.length;
  const above = win.start > 0 ? fit([S(hasBelow ? `${g.unicode ? '↑' : '^'} ${rows(0, win.start)} more above` : `${g.unicode ? '↑' : '^'} ${range}`, 'secondary')], w, g.ellipsis) : null;
  const below = hasBelow ? fit([S(`${g.unicode ? '↓' : 'v'} ${range}`, 'secondary')], w, g.ellipsis) : null;
  return { ...win, above, below };
}

/**
 * A column's rows in `room` rows: all of them when they fit; else the first room − 1 and a row saying which show ("↓ 1–N of
 * M rows"), so a clipped column always says it is clipped.
 */
export function clipRows(lines: readonly Line[], w: number, room: number, g: Glyphs): Line[] {
  if (lines.length <= room) return rowsOf(lines, w, room, g.ellipsis);
  const shown = Math.max(0, room - 1);
  return [...rowsOf(lines, w, shown, g.ellipsis), fit([S(`${g.unicode ? '↓' : 'v'} 1–${shown} of ${lines.length} rows`, 'secondary')], w, g.ellipsis)];
}

/**
 * A selected row as the selection bar draws it: every segment selected, and its quiet words in the primary text colour (the
 * grey secondary on the bar's charcoal is below the contrast floor).
 */
export const onBar = (l: Line): Line => l.map((s) => ({ ...s, selected: true, ...(s.role === 'secondary' || s.role === 'border' ? { role: 'text' as Role } : {}) }));

/**
 * R5 (H131; the QA of e7f853e, defect 2): what no Timmy surface draws yet of a tab's subject (`none`: never a promise that
 * another surface has it), then what the Workbench's own keys show for that tab in truth: [c] the companion's page of the tab
 * (its records in words, in a browser), [s] Studio's canvas where it applies. Wrapped under themselves, never cut.
 */
export function limitRows(none: string, show: { c: string; s?: string }, w: number, g: Glyphs): Line[] {
  const key = (k: string): Seg => S(`[${k}]`, 'action');
  // the keys by their full names ("Companion · Show"), or their short ones where those keep the words to fewer rows
  const line = (full: boolean): Line => [S(`${none} `, 'secondary'), key('c'), S(` Companion${full ? ` ${g.sep} Show` : ''}: ${show.c}${show.s ? '; ' : '.'}`, 'secondary'), ...(show.s ? [key('s'), S(` Studio${full ? ` ${g.sep} Show` : ''}: ${show.s}.`, 'secondary')] : [])];
  const width = Math.max(8, w);
  const full = wrapSegs(line(true), width);
  const short = wrapSegs(line(false), width);
  return short.length < full.length ? short : full;
}

/**
 * What a terminal cannot draw, said where a tab refers to a preview, and what the Workbench's keys show for it in truth
 * (limitRows): R5 (H131; the QA of e7f853e, defect 2): never "[c] the companion draws it" where the companion has no such view.
 */
export function previewNote(w: number, g: Glyphs, none = 'A terminal draws no images, 3D or live previews, and no Timmy surface draws them for this tab yet.', c = 'this tab in a browser page, in words'): Line[] {
  return limitRows(none, { c }, w, g);
}

/** Rows of a column: each fitted to `w`, and at most `room` of them (blank rows below to the room when `pad`). */
export function rowsOf(lines: readonly Line[], w: number, room: number, ellipsis: string, pad = false): Line[] {
  const out = lines.slice(0, Math.max(0, room)).map((l) => fit(l, w, ellipsis));
  if (pad) while (out.length < room) out.push(fit([], w, ellipsis));
  return out;
}

/** Splits `total` cells among columns by weight, each at least `min` (the last takes what rounding leaves). */
export function widths(total: number, weights: readonly number[], min = 12): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const out = weights.map((w) => Math.max(min, Math.floor((total * w) / sum)));
  const used = out.slice(0, -1).reduce((a, b) => a + b, 0);
  out[out.length - 1] = Math.max(1, total - used);
  return out;
}

/** The rule between two columns: a cell of air, the line, a cell of air. */
export const RULE_CELLS = 3;
const rule = (g: Glyphs): Seg => S(` ${g.unicode ? '│' : '|'} `, 'border');

/**
 * Columns side by side, each exactly its width, joined by a rule: `height` rows (a column with fewer rows is blank below).
 * Every row is the sum of the widths and the rules, never more.
 */
export function sideBySide(cols: ReadonlyArray<{ w: number; lines: readonly Line[] }>, height: number, g: Glyphs): Line[] {
  const out: Line[] = [];
  for (let y = 0; y < height; y++) {
    const row: Line = [];
    cols.forEach((col, i) => {
      if (i) row.push(rule(g));
      row.push(...fit(col.lines[y] ?? [], col.w, g.ellipsis));
    });
    out.push(row);
  }
  return out;
}

/**
 * A titled box `w` cells wide (the references' cards): its title on the top edge, a note at the edge's right end when there
 * is room, its rows inside with a cell of air on each side, each cut at the box's edge. `edge` colours the box and its title
 * (amber for .intent and .predict, green for a verified receipt, grey for structure); `heavy` draws the selected one heavy.
 * Below 8 cells there is no room for a box: the rows alone.
 */
export function card(o: { w: number; title: Seg[]; note?: Seg[]; body: readonly Line[]; edge: Role; heavy?: boolean; g: Glyphs }): Line[] {
  const { w, g } = o;
  if (w < 8) return [fit(o.title, w, g.ellipsis), ...o.body.map((l) => fit(l, w, g.ellipsis))];
  const b = boxOf(g, o.heavy === true);
  const inner = w - 2;
  const note = o.note && lineCells(o.title) + lineCells(o.note) + 6 <= inner ? [S(' '), ...o.note, S(' ')] : [];
  const titleRoom = Math.max(1, inner - 3 - lineCells(note));
  const title = fit([S(' '), ...o.title, S(' ')], Math.min(titleRoom, lineCells(o.title) + 2), g.ellipsis);
  const fill = Math.max(0, inner - 1 - lineCells(title) - lineCells(note));
  const top: Line = [S(`${b.tl}${b.h}`, o.edge), ...title, S(b.h.repeat(fill), o.edge), ...note, S(b.tr, o.edge)];
  const rows = o.body.map((l): Line => [S(b.v, o.edge), S(' '), ...fit(l, inner - 2, g.ellipsis), S(' '), S(b.v, o.edge)]);
  return [fit(top, w, g.ellipsis), ...rows, [S(`${b.bl}${b.h.repeat(inner)}${b.br}`, o.edge)]];
}

/** A bar of `w` cells, `p` of it filled (0 to 1): filled in `role`, the rest structure grey. */
export function bar(p: number, w: number, role: Role, g: Glyphs): Seg[] {
  const cellsOn = Math.max(0, Math.min(w, Math.round(Math.max(0, Math.min(1, p)) * w)));
  const on = g.unicode ? '█' : '#';
  const off = g.unicode ? '░' : '.';
  return [S(on.repeat(cellsOn), role), S(off.repeat(w - cellsOn), 'border')];
}

/** label: value rows for the Inspector, the value wrapped under itself (never cut), the label quiet and padded. */
export function fieldRows(label: string, value: string, width: number, role: Role = 'text', pad = 10): Line[] {
  const room = Math.max(8, width - pad - 1);
  const [first = '', ...rest] = wrapText(value, room);
  return [[S(`${label.padEnd(pad)} `, 'secondary'), S(first, role)], ...rest.map((r) => [S(' '.repeat(pad + 1)), S(r, role)])];
}

/**
 * The first of `rows` (the fullest wording first) that fits in `w` cells whole, fitted to `w`; when none does, the last, cut
 * at the edge. A row's words that must be said go in its every wording, so a narrow column drops what follows them, never them.
 */
export const first = (w: number, ellipsis: string, ...rows: Line[]): Line =>
  fit(rows.find((r) => lineCells(r) <= w) ?? rows[rows.length - 1] ?? [], w, ellipsis);

/**
 * Parts on rows of `w` cells after `indent`, each part whole (one wider than a row is cut), joined by `sep`: all the groups
 * on one row when they fit, else each group from a row of its own, as many rows as it takes. Rows as wide as their words.
 */
export function flow(groups: ReadonlyArray<readonly string[]>, w: number, indent: string, sep: string, role: Role, ellipsis: string): Line[] {
  const room = Math.max(1, w - cells(indent));
  const one = groups.flat().join(sep);
  const rows: string[] = [];
  if (cells(one) <= room) rows.push(one);
  else {
    for (const group of groups) {
      let cur = '';
      for (const p of group) {
        if (cur && cells(`${cur}${sep}${p}`) <= room) cur = `${cur}${sep}${p}`;
        else { if (cur) rows.push(cur); cur = p; }
      }
      if (cur) rows.push(cur);
    }
  }
  return rows.map((r) => [S(indent), S(cut(r, room, ellipsis), role)]);
}

/** Wrapped text as rows of one role, each at most `width` cells (an indent counts). */
export const para = (text: string, width: number, role: Role = 'secondary', indent = ''): Line[] =>
  wrapText(text, Math.max(8, width - indent.length)).map((t) => [S(`${indent}${t}`, role)]);
