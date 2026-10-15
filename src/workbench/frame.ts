/**
 * R4 (H110): the Workbench's frame. Each zone is a panel: a border with its title in the top edge, and rows fitted inside. The
 * region that has the keyboard has a heavier border in amber (DESIGN.md B10) and a marker before its title, so focus is visible by
 * shape and words as well as by colour. Without Unicode the borders are + - | and the marker is >.
 *
 * compose() lays the panels into the screen's rows by the layout (src/workbench/layout.ts): every row is exactly the
 * terminal's width, so nothing wraps and nothing is left of an earlier frame.
 */
import type { Layout, Rect } from './layout.js';
import { fit, lineCells, type Line, type Seg } from './text.js';

export interface Glyphs {
  unicode: boolean;
  ellipsis: string;
  /** the selected row's marker */
  cursor: string;
  /** the focused panel's marker */
  focus: string;
  bullet: string;
  sep: string;
  arrow: string;
  warn: string;
  ok: string;
  fail: string;
  check: string;
  uncheck: string;
}

export const glyphsFor = (unicode: boolean): Glyphs => (unicode
  ? { unicode, ellipsis: '…', cursor: '▸', focus: '◆', bullet: '●', sep: '·', arrow: '→', warn: '⚠', ok: '✓', fail: '✖', check: '[x]', uncheck: '[ ]' }
  : { unicode, ellipsis: '...', cursor: '>', focus: '>', bullet: '*', sep: '-', arrow: '->', warn: '!', ok: '+', fail: 'x', check: '[x]', uncheck: '[ ]' });

interface Box { tl: string; tr: string; bl: string; br: string; h: string; v: string }
const LIGHT: Box = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
const HEAVY: Box = { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' };
const ASCII: Box = { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
const ASCII_FOCUS: Box = { tl: '#', tr: '#', bl: '#', br: '#', h: '=', v: '#' };

export interface PanelSpec {
  title: string;
  /** the rows inside, before fitting (more than fit are left out: the caller scrolls) */
  lines: Line[];
  focused: boolean;
  /** words at the right of the top edge (a count, a state) */
  note?: string;
  /** a row for the bottom edge (a hint) */
  footer?: string;
}

/** The width a panel's rows are fitted to: its inside less one cell of air on each side. */
export const innerWidth = (w: number): number => (w - 2 >= 6 ? w - 4 : Math.max(0, w - 2));

/** A panel as exactly `r.h` rows of exactly `r.w` cells. */
export function panel(p: PanelSpec, r: Rect, g: Glyphs): Line[] {
  if (r.w < 4 || r.h < 2) return Array.from({ length: Math.max(0, r.h) }, () => fit([], Math.max(0, r.w), g.ellipsis));
  const b = g.unicode ? (p.focused ? HEAVY : LIGHT) : (p.focused ? ASCII_FOCUS : ASCII);
  const edge: Seg['role'] = p.focused ? 'focus' : 'border';
  const inner = r.w - 2;
  const title = `${p.focused ? `${g.focus} ` : ''}${p.title}`;
  // the title stays whole before a note does: a note that leaves no room for it is left out
  const note = p.note && lineCells([{ text: title }]) + lineCells([{ text: ` ${p.note} ` }]) <= inner - 3 ? ` ${p.note} ` : '';
  const head: Line = [{ text: `${b.tl}${b.h} `, role: edge }];
  const titleRoom = Math.max(0, inner - 3 - lineCells([{ text: note }]));
  const t = fit([{ text: title, role: p.focused ? 'focus' : 'strong' }], Math.min(titleRoom, lineCells([{ text: title }])), g.ellipsis);
  head.push(...t, { text: ' ', role: edge });
  const used = 3 + lineCells(t) + 1;
  const fill = Math.max(0, inner + 2 - used - lineCells([{ text: note }]) - 1);
  head.push({ text: b.h.repeat(fill), role: edge });
  if (note) head.push({ text: note, role: 'secondary' });
  head.push({ text: b.tr, role: edge });
  const rows: Line[] = [fit(head, r.w, g.ellipsis)];
  const body = r.h - 2;
  // one cell of air on each side of the rows, inside the border
  const pad = inner >= 6 ? 1 : 0;
  for (let i = 0; i < body; i++) {
    const content = p.lines[i] ?? [];
    const fitted = fit(content, inner - 2 * pad, g.ellipsis);
    const sel = fitted[0]?.selected === true;
    rows.push([{ text: b.v, role: edge }, ...(pad ? [{ text: ' ', ...(sel ? { selected: true } : {}) }] : []), ...fitted, ...(pad ? [{ text: ' ', ...(fitted[fitted.length - 1]?.selected ? { selected: true } : {}) }] : []), { text: b.v, role: edge }]);
  }
  const foot: Line = [{ text: b.bl, role: edge }];
  if (p.footer && inner > 4) {
    const f = fit([{ text: ` ${p.footer} `, role: 'secondary' }], Math.min(inner - 2, lineCells([{ text: ` ${p.footer} ` }])), g.ellipsis);
    foot.push({ text: b.h, role: edge }, ...f, { text: b.h.repeat(Math.max(0, inner - 1 - lineCells(f))), role: edge });
  } else foot.push({ text: b.h.repeat(inner), role: edge });
  foot.push({ text: b.br, role: edge });
  rows.push(foot);
  return rows;
}

export interface Placed { rect: Rect; rows: Line[] }

/** The screen: every placed panel's rows at its place, blank cells elsewhere; each row exactly `columns` wide. */
export function compose(l: Pick<Layout, 'columns' | 'rows'>, placed: readonly Placed[]): Line[] {
  const screen: Line[] = [];
  for (let y = 0; y < l.rows; y++) {
    // the panels that cover this row, left to right
    const here = placed.filter((p) => y >= p.rect.y && y < p.rect.y + p.rect.h).sort((a, b) => a.rect.x - b.rect.x);
    const row: Line = [];
    let x = 0;
    for (const p of here) {
      if (p.rect.x > x) { row.push({ text: ' '.repeat(p.rect.x - x) }); x = p.rect.x; }
      if (p.rect.x < x) continue; // overlapping panels are never laid out; the first one wins
      row.push(...(p.rows[y - p.rect.y] ?? fit([], p.rect.w)));
      x += p.rect.w;
    }
    screen.push(fit(row, l.columns));
  }
  return screen;
}

/** The plain text of a composed screen (what a click is read against, and what the tests read). */
export const screenText = (screen: readonly Line[]): string[] => screen.map((l) => l.map((s) => s.text).join(''));
