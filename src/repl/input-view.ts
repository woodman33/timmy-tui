/**
 * How the input looks (playbook §17.2): `block` (tinted pad, ` › text`, tinted pad) when the ground
 * was measured and a tint exists; `bordered` (rules around `› text`) otherwise. Text on the tint
 * keeps the default foreground. Long text wraps by display width; the cursor follows it.
 */
import { serialize, type Theme } from '../term/theme.js';
import { truncate, visibleWidth } from '../term/width.js';
import type { LineEditor } from './editor.js';

export interface InputView {
  lines: string[];
  /** Zero-based row within `lines` and cell column for the terminal cursor. */
  cursor: { row: number; col: number };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Visual rows for one logical line, and where `cursorIndex` (if on this line) lands. */
function wrapLine(line: string, width: number, cursorIndex: number | null): { rows: string[]; cursor: { row: number; col: number } | null } {
  const rows: string[] = [''];
  let used = 0;
  let at = 0;
  let cursor: { row: number; col: number } | null = cursorIndex === 0 ? { row: 0, col: 0 } : null;
  for (const { segment } of graphemes.segment(line)) {
    const w = visibleWidth(segment);
    if (used + w > width && used > 0) {
      rows.push('');
      used = 0;
    }
    rows[rows.length - 1] += segment;
    used += w;
    at += segment.length;
    if (cursorIndex !== null && at === cursorIndex) cursor = { row: rows.length - 1, col: used };
  }
  return { rows, cursor };
}

export function hintText(theme: Theme): string {
  const s = theme.glyphs.sep;
  return `  Enter to send ${s} Ctrl+J newline ${s} / commands`;
}

export interface MenuCommand {
  name: string;
  description: string;
}

/** The commands a typed `/word` matches (B6), in registry order; none once arguments begin. */
export function menuMatches(text: string, commands: readonly MenuCommand[]): MenuCommand[] {
  const m = /^\/(\S*)$/.exec(text);
  return m ? commands.filter((c) => c.name.startsWith(m[1])) : [];
}

const MENU_ROWS = 6;

/** Below the input while a command is typed: the matches, then which one Tab completes; else the hint. */
function belowInput(editor: LineEditor, theme: Theme, columns: number, commands: readonly MenuCommand[]): string[] {
  const matches = menuMatches(editor.text, commands);
  const fit = (text: string) => truncate(text, columns, theme.glyphs.ellipsis);
  if (!matches.length) return [serialize([{ text: fit(hintText(theme)), role: 'secondary' }], theme)];
  return [
    // B9 (round R1): the selected command, the one Tab completes, is in Homebrew green.
    ...matches.slice(0, MENU_ROWS).map((c, i) => serialize([{ text: fit(`  /${c.name.padEnd(11)}`), role: i === 0 ? 'accent' : undefined }, { text: ` ${c.description}`, role: 'secondary' }], theme)),
    serialize([{ text: fit(`  Tab completes /${matches[0].name}`), role: 'secondary' }], theme),
  ];
}

export function renderInput(editor: LineEditor, theme: Theme, columns: number, commands: readonly MenuCommand[] = []): InputView {
  const g = theme.glyphs;
  const block = theme.tint !== null;
  // B9 (round R1): the prompt is Homebrew green where the terminal's green reads; its color closes with
  // 39 alone, so the tint behind it stays.
  const mark = serialize([{ text: g.prompt, role: 'accent' }], theme);
  const first = block ? ` ${mark} ` : `${mark} `;
  const prefixWidth = visibleWidth(first);
  const width = Math.max(1, columns - prefixWidth - 1);
  const { line: cursorLine, col: cursorCol } = editor.position;
  const rows: string[] = [];
  let cursor = { row: 0, col: prefixWidth };
  editor.lines.forEach((line, i) => {
    const wrapped = wrapLine(line, width, i === cursorLine ? cursorCol : null);
    if (wrapped.cursor) cursor = { row: rows.length + wrapped.cursor.row, col: prefixWidth + wrapped.cursor.col };
    rows.push(...wrapped.rows);
  });
  const prefix = (i: number) => (i === 0 ? first : ' '.repeat(prefixWidth));
  const below = belowInput(editor, theme, columns, commands);
  if (block) {
    const tinted = (s: string) => `\x1b[${theme.tint}m\x1b[K${s}\x1b[49m`;
    return {
      lines: [tinted(''), ...rows.map((r, i) => tinted(prefix(i) + r)), tinted(''), ...below],
      cursor: { row: cursor.row + 1, col: cursor.col },
    };
  }
  const rule = serialize([{ text: g.rule.repeat(columns), role: 'rule' }], theme);
  return { lines: [rule, ...rows.map((r, i) => prefix(i) + r), rule, ...below], cursor: { row: cursor.row + 1, col: cursor.col } };
}
