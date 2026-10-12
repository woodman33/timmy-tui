/**
 * A line of the REPL's own (a notice, a command's output) wider than the terminal, wrapped instead of cut (round R4, H98,
 * journey-2). Before, every such line was cut at the width with "…" (src/term/theme.ts fitSegments), so at 80 columns a
 * /run's end and progress lines lost the reason and the operation id. Now the line breaks between words onto continuation
 * lines indented two columns more than the line itself (a hanging indent), and no row is wider than the terminal (the
 * live region counts rows: a row the terminal wraps by itself would throw it off, ledger row 163).
 *
 * Never inside a word, so never inside an id: only a word wider than a whole row (a long path, say) is broken by cells,
 * every character kept. Escape sequences take no cells; a link (OSC 8, open to close) is one word whatever it holds, and
 * a word that carries an escape is never broken (it keeps its row, whole).
 */
import type { Segment } from '../term/theme.js';
import { visibleWidth } from '../term/width.js';

interface Token { space: boolean; pieces: Segment[]; width: number; escapes: boolean }

/** An OSC 8 link from its open to its close (ST or BEL terminated). */
const LINK = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)[\s\S]*?\x1b\]8;;(?:\x07|\x1b\\)/y;
/** Any other escape sequence (as src/term/width.ts strips them). */
const ESCAPE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/y;

/** The segments as words and the spaces between them, each piece keeping its segment's role. */
function tokenize(segments: readonly Segment[]): Token[] {
  const tokens: Token[] = [];
  const add = (space: boolean, text: string, role: Segment['role'], escapes = false): void => {
    let last = tokens.at(-1);
    if (!last || last.space !== space) { last = { space, pieces: [], width: 0, escapes: false }; tokens.push(last); }
    const piece = last.pieces.at(-1);
    if (piece && piece.role === role) piece.text += text; else last.pieces.push(role ? { text, role } : { text });
    last.width += visibleWidth(text);
    last.escapes ||= escapes;
  };
  for (const s of segments) {
    for (let i = 0; i < s.text.length;) {
      LINK.lastIndex = i;
      ESCAPE.lastIndex = i;
      const sequence = LINK.exec(s.text) ?? ESCAPE.exec(s.text);
      if (sequence) { add(false, sequence[0], s.role, true); i += sequence[0].length; continue; }
      const ch = String.fromCodePoint(s.text.codePointAt(i)!);
      add(/\s/.test(ch), /\s/.test(ch) ? ' ' : ch, s.role);
      i += ch.length;
    }
  }
  return tokens;
}

/** A word's first `cells` cells and the rest (at least one character first, so a row always takes something). */
function splitWord(t: Token, cells: number): [Token, Token] {
  const head: Token = { space: false, pieces: [], width: 0, escapes: false };
  const rest: Token = { space: false, pieces: [], width: 0, escapes: false };
  for (const p of t.pieces) {
    for (const ch of Array.from(p.text)) {
      const w = visibleWidth(ch);
      const into = rest.width === 0 && (head.width + w <= cells || head.width === 0) ? head : rest;
      const last = into.pieces.at(-1);
      if (last && last.role === p.role) last.text += ch; else into.pieces.push(p.role ? { text: ch, role: p.role } : { text: ch });
      into.width += w;
    }
  }
  return [head, rest];
}

/** Adjacent pieces of one role as one segment. */
function merged(line: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of line) {
    if (!s.text) continue;
    const last = out.at(-1);
    if (last && last.role === s.role) last.text += s.text; else out.push(s.role ? { text: s.text, role: s.role } : { text: s.text });
  }
  return out;
}

/**
 * `segments` as rows no wider than `width`: the line itself when it fits; else broken between words, each continuation
 * row indented two columns more than the line's own leading spaces (at most a quarter of the width).
 */
export function wrapSegments(segments: readonly Segment[], width: number): Segment[][] {
  const total = segments.reduce((n, s) => n + visibleWidth(s.text), 0);
  if (!Number.isFinite(width) || width <= 0 || total <= width) return [[...segments]];
  const tokens = tokenize(segments);
  const lead = tokens[0]?.space ? tokens[0].width : 0;
  const hang = Math.min(lead + 2, Math.floor(width / 4));
  const rows: Segment[][] = [];
  let row: Segment[] = [];
  let used = 0;
  let words = 0;
  let gap: Token | null = null;
  const next = (): void => { rows.push(merged(row)); row = [{ text: ' '.repeat(hang) }]; used = hang; words = 0; gap = null; };
  for (const t of tokens) {
    if (t.space) {
      // the line's own leading spaces stay; spaces between words wait for the next word (none at a row's end)
      if (!rows.length && !words) { row.push(...t.pieces); used += t.width; } else gap = t;
      continue;
    }
    const before: Token | null = words ? gap : null;
    if (words && used + (before?.width ?? 0) + t.width > width) next();
    else if (before) { row.push(...before.pieces); used += before.width; }
    gap = null;
    let word = t;
    // a word wider than what is left of a row that holds no word yet: by cells, unless it carries an escape
    while (!word.escapes && !words && used + word.width > width && width - used > 0) {
      const [head, rest] = splitWord(word, width - used);
      row.push(...head.pieces);
      used += head.width;
      words++;
      if (!rest.width) { word = rest; break; }
      next();
      word = rest;
    }
    if (word.pieces.length) { row.push(...word.pieces); used += word.width; words++; }
  }
  rows.push(merged(row));
  return rows;
}
