/**
 * The editing model behind the block input (playbook §17.2): grapheme-safe insert and delete,
 * word moves, Home/End per line, Ctrl+U and Ctrl+K (B6 keeps Ctrl+K as kill-to-end), multi-line
 * text with up/down between lines, and history from the first and last line. No I/O here.
 */
import { visibleWidth } from '../term/width.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WORD = /[\p{L}\p{N}_]/u;

function boundaries(text: string): number[] {
  const out = [0];
  for (const { index, segment } of graphemes.segment(text)) out.push(index + segment.length);
  return [...new Set(out)];
}

export class LineEditor {
  text = '';
  cursor = 0;
  private readonly past: string[];
  private historyIndex: number | null = null;
  private draft = '';

  constructor(history: string[] = []) {
    this.past = [...history];
  }

  get history(): string[] {
    return [...this.past];
  }

  get lines(): string[] {
    return this.text.split('\n');
  }

  /** Line number and index within that line for the cursor. */
  get position(): { line: number; col: number } {
    const before = this.text.slice(0, this.cursor).split('\n');
    return { line: before.length - 1, col: before[before.length - 1].length };
  }

  private lineStart(): number {
    return this.text.lastIndexOf('\n', this.cursor - 1) + 1;
  }

  private lineEnd(): number {
    const i = this.text.indexOf('\n', this.cursor);
    return i === -1 ? this.text.length : i;
  }

  private prev(i: number): number {
    return boundaries(this.text).filter((b) => b < i).pop() ?? 0;
  }

  private next(i: number): number {
    return boundaries(this.text).find((b) => b > i) ?? this.text.length;
  }

  private splice(from: number, to: number, insert = ''): void {
    this.text = this.text.slice(0, from) + insert + this.text.slice(to);
    this.cursor = from + insert.length;
  }

  insert(s: string): void {
    this.splice(this.cursor, this.cursor, s.replace(/\r\n?/g, '\n'));
  }

  backspace(): void {
    if (this.cursor > 0) this.splice(this.prev(this.cursor), this.cursor);
  }

  deleteForward(): void {
    if (this.cursor < this.text.length) this.splice(this.cursor, this.next(this.cursor));
  }

  left(): void {
    this.cursor = this.prev(this.cursor);
  }

  right(): void {
    this.cursor = this.next(this.cursor);
  }

  private wordStartBefore(i: number): number {
    while (i > 0 && !WORD.test(this.text[i - 1])) i--;
    while (i > 0 && WORD.test(this.text[i - 1])) i--;
    return i;
  }

  wordLeft(): void {
    this.cursor = this.wordStartBefore(this.cursor);
  }

  wordRight(): void {
    let i = this.cursor;
    while (i < this.text.length && !WORD.test(this.text[i])) i++;
    while (i < this.text.length && WORD.test(this.text[i])) i++;
    this.cursor = i;
  }

  home(): void {
    this.cursor = this.lineStart();
  }

  end(): void {
    this.cursor = this.lineEnd();
  }

  deleteWordBefore(): void {
    this.splice(this.wordStartBefore(this.cursor), this.cursor);
  }

  killToLineStart(): void {
    this.splice(this.lineStart(), this.cursor);
  }

  killToLineEnd(): void {
    this.splice(this.cursor, this.lineEnd());
  }

  clear(): void {
    this.text = '';
    this.cursor = 0;
    this.historyIndex = null;
  }

  /** Same display column on line `target` (or its end). */
  private moveToLine(target: number): void {
    const lines = this.lines;
    const { line, col } = this.position;
    const want = visibleWidth(lines[line].slice(0, col));
    let index = 0;
    for (let l = 0; l < target; l++) index += lines[l].length + 1;
    let width = 0;
    let at = 0;
    for (const { segment } of graphemes.segment(lines[target])) {
      const w = visibleWidth(segment);
      if (width + w > want) break;
      width += w;
      at += segment.length;
    }
    this.cursor = index + at;
  }

  private recall(index: number | null): void {
    if (this.historyIndex === null && index !== null) this.draft = this.text;
    this.historyIndex = index;
    this.text = index === null ? this.draft : this.past[index];
    this.cursor = this.text.length;
  }

  up(): void {
    const { line } = this.position;
    if (line > 0) return this.moveToLine(line - 1);
    if (this.past.length === 0) return;
    const index = this.historyIndex === null ? this.past.length - 1 : Math.max(0, this.historyIndex - 1);
    this.recall(index);
  }

  down(): void {
    const { line } = this.position;
    if (line < this.lines.length - 1) return this.moveToLine(line + 1);
    if (this.historyIndex === null) return;
    const index = this.historyIndex + 1;
    this.recall(index >= this.past.length ? null : index);
  }

  submit(): string {
    const text = this.text;
    if (text.trim() && this.past[this.past.length - 1] !== text) this.past.push(text);
    this.clear();
    this.draft = '';
    return text;
  }
}
