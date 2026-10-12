/**
 * R4 (H110): the terminal Workbench's lines. A screen is a list of rows; a row is a list of segments, each a piece of text
 * with a role (src/workbench/theme.ts maps roles to Timmy Homebrew's colours, and every role's meaning is also in its words).
 * Every row is fitted to its width here, before Ink draws it: a row is never wider than its zone, and text that does not fit
 * ends in an ellipsis, cut at a word where one is near, so nothing is cut mid-word without one.
 */
import { truncate, visibleWidth, wrap } from '../term/width.js';

export type Role =
  /** most text: off-white */
  | 'text'
  /** labels, hints and quiet facts */
  | 'secondary'
  /** a name or a heading: off-white, bold */
  | 'strong'
  /** a command, a key, a button: Homebrew green */
  | 'action'
  /** a link or a place to go: blue */
  | 'link'
  /** a named decision that waits on a person (NEEDS YOU, waiting on you): amber */
  | 'attention'
  /** failed, refused */
  | 'failure'
  /** made by a model, or sent over the network */
  | 'ai'
  /** a border or a rule */
  | 'border'
  /** the border of the region that has the keyboard */
  | 'focus';

export interface Seg {
  text: string;
  role?: Role;
  bold?: boolean;
  underline?: boolean;
  /** drawn on the selection's ground (the selected row) */
  selected?: boolean;
  /** drawn inverted (a text cursor) */
  inverse?: boolean;
}

export type Line = Seg[];

export const cells = (text: string): number => visibleWidth(text);
export const lineCells = (line: Line): number => line.reduce((n, s) => n + visibleWidth(s.text), 0);

/** Plain text of a line (what a test or the JSON reads). */
export const plain = (line: Line): string => line.map((s) => s.text).join('');

/**
 * `text` cut to at most `room` cells: whole when it fits; else up to a space near the end and the ellipsis, or (no space
 * near) the ellipsis after as much as fits. An empty string when there is no room at all.
 */
export function cut(text: string, room: number, ellipsis = '…'): string {
  if (room <= 0) return '';
  if (visibleWidth(text) <= room) return text;
  const e = visibleWidth(ellipsis);
  // no room for a letter and the ellipsis: the ellipsis alone (never a letter without it)
  if (room <= e) return room === e ? ellipsis : '';
  const hard = truncate(text, room, ellipsis);
  const body = hard.slice(0, hard.length - ellipsis.length);
  const space = body.lastIndexOf(' ');
  // a word boundary in the last third of the room: cut there, so the last word shown is whole
  if (space > 0 && visibleWidth(body.slice(0, space)) >= Math.floor(room * 0.66)) return `${body.slice(0, space).replace(/[\s,;:·-]+$/, '')}${ellipsis}`;
  return hard;
}

/** The line fitted to exactly `width` cells: segments kept whole while they fit, the first that does not cut (ellipsis), then padding. */
export function fit(line: Line, width: number, ellipsis = '…'): Line {
  const out: Line = [];
  let used = 0;
  for (const s of line) {
    if (used >= width) break;
    const w = visibleWidth(s.text);
    if (used + w <= width) { out.push(s); used += w; continue; }
    const room = width - used;
    const text = cut(s.text, room, ellipsis);
    if (text) { out.push({ ...s, text }); used += visibleWidth(text); }
    break;
  }
  if (used < width) {
    const last = out[out.length - 1];
    // a selected row keeps its ground to the edge
    out.push({ text: ' '.repeat(width - used), ...(last?.selected ? { selected: true } : {}) });
  }
  return out;
}

/** Two parts on one row: `left` from the start, `right` at the end; `right` is kept whole first, `left` cut to what is left. */
export function spread(left: Line, right: Line, width: number, ellipsis = '…'): Line {
  const r = lineCells(right);
  if (r >= width) return fit(right, width, ellipsis);
  const leftRoom = Math.max(0, width - r - 1);
  const l = fit(left, leftRoom, ellipsis);
  return [...l, { text: ' ' }, ...right];
}

/**
 * Pieces in order of priority (the first is kept first), joined by `gap`, each kept whole or left out: what fits in `width`
 * cells, in the order given. A piece left out is never cut in half.
 */
export function pick(pieces: Line[], width: number, gap: Seg = { text: '  ' }): Line {
  const kept = new Set<number>();
  let used = 0;
  pieces.forEach((p, i) => {
    const w = lineCells(p) + (kept.size ? cells(gap.text) : 0);
    if (used + w <= width) { kept.add(i); used += w; }
  });
  const out: Line = [];
  pieces.forEach((p, i) => { if (kept.has(i)) { if (out.length) out.push(gap); out.push(...p); } });
  return out;
}

/** Text wrapped at words into rows of at most `width` cells (a word longer than a row is cut with the ellipsis). */
export function wrapText(text: string, width: number, ellipsis = '…'): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    for (const row of wrap(para, width)) out.push(visibleWidth(row) > width ? cut(row, width, ellipsis) : row);
  }
  return out;
}

/** A line of one role. */
export const say = (text: string, role: Role = 'text', o: Omit<Seg, 'text' | 'role'> = {}): Line => [{ text, role, ...o }];

/** Words for how long: "0.4 s", "12 s", "3 min", "2 h 5 min". */
export function took(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return 'time unknown';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 120) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A time of day from an ISO time ("14:05:09"), or the text as it is. */
export function clock(iso: string | undefined | null): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toTimeString().slice(0, 8);
}

/** "1 job", "2 jobs". */
export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
