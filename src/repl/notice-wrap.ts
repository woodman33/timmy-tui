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
 *
 * R4 (helper H107; r25 on the operator's Mac, finding D6): nor between the words of a number and what it counts. At 80
 * columns a /run's progress line broke "run 1 s" with the "s" alone on the next row. A space is a non-breaking join between
 *   - a number and its unit: "1 s", "4.2 s", "<0.1 s", "12 KB", "160 mm";
 *   - a duration's unit and the number after it: "1 min 30 s", "1 h 5 min";
 *   - "run", "ran", "took", "exit" or "exited" (a "(" before it too) and the number after it: "run 1 s", "(exit 4";
 *   - a number, "of" and a number: "1 of 3".
 * Such a group keeps one row, as a word does, when a row can hold it; a group wider than that breaks between its words
 * again (never by cells).
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

// R4 (H107; r25 D6): the words a row never breaks between (see the module comment)
const UNIT = /^(?:ms|s|min|h|KB|MB|GB|kB|B|bytes?|%|px|mm|cm|fps)[.,;:)]*$/;
const NUMBER = /^[(<~≈]?-?\d[\d.,]*$/;
const STARTS_NUMBER = /^[(<~≈]?-?\d/;
const BEFORE_NUMBER = /^\(?(?:run|ran|took|exit|exited)$/;
const DURATION_UNIT = /^(?:min|h)$/;

/** Whether the space between words `a` and `b` (with the words around them) is a non-breaking join. */
function joins(before: string | undefined, a: string, b: string, after: string | undefined): boolean {
  if (NUMBER.test(a) && UNIT.test(b)) return true; // 1 s, 4.2 s, 12 KB
  if (DURATION_UNIT.test(a) && before !== undefined && NUMBER.test(before) && STARTS_NUMBER.test(b)) return true; // 1 min 30 s
  if (BEFORE_NUMBER.test(a) && STARTS_NUMBER.test(b)) return true; // run 1 s, exit 4
  if (NUMBER.test(a) && b === 'of' && after !== undefined && STARTS_NUMBER.test(after)) return true; // 1 of 3
  return a === 'of' && before !== undefined && NUMBER.test(before) && STARTS_NUMBER.test(b);
}

/**
 * R4 (H107): the tokens with each group of words joined by non-breaking spaces made one word, when a row of `room` cells
 * can hold the group; a group wider than that stays as its words.
 */
function glued(tokens: Token[], room: number): Token[] {
  const textOf = (t: Token | undefined): string | undefined => (t && !t.space && !t.escapes ? t.pieces.map((p) => p.text).join('') : undefined);
  const word = (i: number): string | undefined => (i >= 0 && i < tokens.length ? textOf(tokens[i]) : undefined);
  // a space token at i is a join when words stand on both sides of it (tokens alternate: word, space, word)
  const join = (i: number): boolean => {
    const a = word(i - 1);
    const b = word(i + 1);
    return tokens[i].space && a !== undefined && b !== undefined && joins(word(i - 3), a, b, word(i + 3));
  };
  const out: Token[] = [];
  for (let i = 0; i < tokens.length;) {
    let j = i;
    if (!tokens[i].space) while (j + 2 < tokens.length && join(j + 1)) j += 2;
    if (j === i) { out.push(tokens[i]); i += 1; continue; }
    const group = tokens.slice(i, j + 1);
    const width = group.reduce((n, t) => n + t.width, 0);
    if (width <= room) out.push({ space: false, pieces: merged(group.flatMap((t) => t.pieces)), width, escapes: false });
    else out.push(...group);
    i = j + 1;
  }
  return out;
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
  const raw = tokenize(segments);
  const lead = raw[0]?.space ? raw[0].width : 0;
  const hang = Math.min(lead + 2, Math.floor(width / 4));
  // R4 (H107; r25 D6): a number and its unit (and the like) as one word, when any row can hold them
  const tokens = glued(raw, width - Math.max(lead, hang));
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
