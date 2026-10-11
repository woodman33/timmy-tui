/**
 * Round R4 (helper H90): `/connect …` in the REPL: the verbs of `timmy connect` (src/connect/commands.ts), said in the
 * REPL's lines. A host key is confirmed through Timmy's own approval box (src/repl/approvals.ts askPerson, with the box the
 * REPL was given: the Workspace's askBox): the fingerprint is shown whole, the box offers no "allow for session", and its
 * answer is the person's. Where no box can be shown (not at a terminal), nothing is trusted. There is no --wait here:
 * `/connect status <job>` reads a job, and `timmy connect wait <job>` waits in a terminal.
 */
import { askPerson, type ApprovalRequest, type Decision } from '../repl/approvals.js';
import type { GlyphSet } from '../term/glyphs.js';
import { sanitize } from '../term/sanitize.js';
import type { Segment } from '../term/theme.js';
import { visibleWidth } from '../term/width.js';
import { connectDo, connectHelp, connectSummary } from './commands.js';

export interface ConnectReplContext {
  print(segments: Segment[]): void;
  glyphs: GlyphSet;
  /** the REPL's NEEDS YOU box (absent: not at a terminal) */
  ask?: (req: ApprovalRequest) => Promise<Decision>;
  /** the folder a relative --to is resolved from (the active project's) */
  cwd?: string;
  /** Timmy home (tests; TIMMY_HOME or ~/timmy otherwise) */
  home?: string;
  /** the terminal's width (default: stdout's columns, or 100) */
  columns?: number;
}

/** A line as words: spaces separate them; '…' and "…" keep theirs; a backslash keeps the next character (outside '…'). */
export function splitWords(line: string): string[] | { error: string } {
  const words: string[] = [];
  let word = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < line.length) { word += line[++i]; continue; }
      word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < line.length) { word += line[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (has) { words.push(word); word = ''; has = false; } continue; }
    word += ch;
    has = true;
  }
  if (quote) return { error: `a ${quote === '"' ? 'double' : 'single'} quote is not closed` };
  if (has) words.push(word);
  return words;
}

/**
 * A line as rows of at most `width` cells: the REPL cuts a row that is too long, and Connect's words (a probe's facts, a
 * job's state) must be read whole. Words keep their roles; a continuation row is indented 6 cells.
 */
export function wrapLine(line: Segment[], width: number): Segment[][] {
  const total = line.reduce((n, x) => n + visibleWidth(x.text), 0);
  if (total <= width) return [line];
  const rows: Segment[][] = [[]];
  let used = 0;
  const indent = 6;
  for (const seg of line) {
    let open: Segment | null = null; // this segment's part in the current row: its pieces join it
    for (const piece of seg.text.split(/(?<= )/)) {
      const w = visibleWidth(piece);
      if (used + w > width && used > indent) { rows.push([{ text: ' '.repeat(indent) }]); used = indent; open = null; }
      const text = used === indent && rows.length > 1 ? piece.replace(/^ +/, '') : piece;
      if (open) open.text += text;
      else { open = { text, ...(seg.role ? { role: seg.role } : {}) }; rows[rows.length - 1].push(open); }
      used += visibleWidth(text);
    }
  }
  return rows;
}

export async function connectRepl(args: string, c: ConnectReplContext): Promise<void> {
  const width = Math.max(40, (c.columns ?? process.stdout.columns ?? 100) - 1);
  // every line's words as plain text (a device's words are cleaned when they are read; a record from before is cleaned here)
  const print = (line: Segment[]): void => { for (const row of wrapLine(line.map((s) => ({ ...s, text: sanitize(s.text) })), width)) c.print(row); };
  const words = splitWords(args);
  if ('error' in words) { c.print([{ text: `  ${words.error}`, role: 'secondary' }]); return; }
  if (!words.length) { for (const line of connectSummary({ glyphs: c.glyphs, by: 'repl', ...(c.home ? { home: c.home } : {}) })) print(line); return; }
  if (words[0] === 'help') { for (const t of connectHelp('repl')) c.print([{ text: `  ${t}` }]); return; }
  const said = await connectDo(words, {
    glyphs: c.glyphs, by: 'repl', ...(c.cwd ? { cwd: c.cwd } : {}), ...(c.home ? { home: c.home } : {}),
    // the person's answer, in the REPL's own box, listed as waiting on them (the Control Room) until it is answered
    ...(c.ask ? { ask: (req: ApprovalRequest, w: Parameters<typeof askPerson>[2]) => askPerson(req, c.ask!, w) } : {}),
  });
  const dash = words.indexOf('--');
  if ((dash < 0 ? words : words.slice(0, dash)).includes('--json')) c.print([{ text: JSON.stringify(said.json) }]);
  else for (const line of said.lines) print(line);
}
