/**
 * The monitor's mouse (fourth order, step 2): a click presses the key it lands on, so every click has a
 * key and the keyboard stays the reference. The monitor owns the alternate screen, so there it asks the
 * terminal for button reports in SGR encoding, and gives the setting back on every way out. A click on a
 * tab presses its digit; a click on a "[key] label" hint presses that key; a hint that names a range or a
 * pair ("[1-6]", "[j/k]") is not one key and does nothing. The wheel moves like the arrow keys. While the
 * terminal reports the mouse, holding Shift (Option in iTerm2) while dragging still selects text.
 */
import { stripEscapes, visibleWidth } from '../term/width.js';

export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

export interface MouseReport { button: number; x: number; y: number; press: boolean }

/** An SGR mouse report, as Ink hands it to `useInput` (its ESC already taken off), or null. */
export function parseMouse(input: string): MouseReport | null {
  const m = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  return m ? { button: Number(m[1]), x: Number(m[2]), y: Number(m[3]), press: m[4] === 'M' } : null;
}

let frame: string[] = [];

/** Keep the text of the last frame written to the screen (from its top row), escapes removed. */
export function recordFrame(chunk: string): void {
  const text = stripEscapes(chunk).replace(/\r/g, '');
  if (text.trim()) frame = text.split('\n');
}

export function lastFrame(): string[] {
  return frame;
}

const NAMED: Record<string, string> = { Enter: 'Enter', Esc: 'Esc', Tab: 'Tab', Space: ' ' };

/** A hint's bracket: "[v]" is the key v; "[Enter]" is Enter; "[1-6]" or "[j/k]" is no single key. */
const keyOf = (inside: string): string | null => NAMED[inside] ?? ([...inside].length === 1 ? inside : null);

interface Target { from: number; to: number; key: string | null }

/** What can be clicked on one line, in 1-based cells. */
function targets(line: string, row: number): Target[] {
  const out: Target[] = [];
  const cells = (index: number): number => visibleWidth(line.slice(0, index));
  const add = (index: number, text: string, key: string | null): void => {
    out.push({ from: cells(index) + 1, to: cells(index) + visibleWidth(text), key });
  };
  // A hint: the bracket, then its label, word by word, up to two spaces, a middle dot or a box line.
  for (const m of line.matchAll(/\[([^\]\s]{1,12})\]((?: (?!·)[^\s│·]+)*)/g)) add(m.index ?? 0, m[0], keyOf(m[1]));
  // The header's tabs, on the first row: " 1 HOME", then the folded ones, " 2", " 3", ...
  if (row === 1 && line.startsWith('TIMMY')) {
    const end = line.indexOf('  chain');
    const bar = end === -1 ? line : line.slice(0, end);
    for (const m of bar.slice(5).matchAll(/(\d)(?: ([A-Z]{2,}))?/g)) add((m.index ?? 0) + 5, m[0], m[1]);
  }
  return out;
}

/** The key a click at column `x`, row `y` (1-based, from the frame's top-left) presses, or null. */
export function keyAt(lines: string[], x: number, y: number): string | null {
  const line = lines[y - 1];
  if (line === undefined) return null;
  return targets(line, y).find((t) => x >= t.from && x <= t.to)?.key ?? null;
}
