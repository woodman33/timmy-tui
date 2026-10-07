import { describe, expect, it } from 'vitest';
import { keyAt, lastFrame, MOUSE_OFF, MOUSE_ON, parseMouse, recordFrame } from '../src/tui/mouse.js';
import { visibleWidth } from '../src/term/width.js';

// Fourth order, step 2: in the monitor a click presses the key it lands on, so every click has a key
// and the keyboard stays the reference. A tab presses its digit; a "[key] label" hint presses its key;
// a hint that names a range or a pair ("[1-6]", "[j/k]") is not a single key and does nothing.
// The lines are a real capture of the monitor's home screen at 100 columns.
const FRAME = [
  'TIMMY   1 HOME  2 3 4 5 6  chain ● 1 · 04022004  bus ■  drops 3  model claude-sonnet-4.5',
  '─'.repeat(100),
  '╭───────────────────────────────────────────────────────────╮  ╭───────────────────────────────────╮',
  '│ ◇ YOUR JOURNEY                                            │  │ ◇ LATEST RECEIPT                  │',
  '│ no operator seal yet — [s] seals your first               │  │ historical record · inspect its   │',
  '│ ○ companion  pair a phone · [q] shows QR                  │',
  ' NORMAL  HOME   [1-6] tab  [Enter] open  [v] verify  [q] QR  [s] seal  [c] chat  chain ● 1  bus ■',
  '  │ [Enter] Begin setup · [q] Quit',
];
/** The 1-based column of the first cell of `needle` on `line` (cells, not string indexes). */
const col = (line: string, needle: string, offset = 0): number => visibleWidth(line.slice(0, line.indexOf(needle))) + 1 + offset;

describe('SGR mouse reports', () => {
  it('reads a press, a release and the wheel; anything else is not a mouse report', () => {
    expect([parseMouse('[<0;17;1M'), parseMouse('\x1b[<0;17;1m'), parseMouse('[<64;5;9M'), parseMouse('[A'), parseMouse('v')]).toEqual([
      { button: 0, x: 17, y: 1, press: true },
      { button: 0, x: 17, y: 1, press: false },
      { button: 64, x: 5, y: 9, press: true },
      null,
      null,
    ]);
  });
  it('asks for button reports in SGR encoding, and gives them back', () => {
    expect({ on: MOUSE_ON, off: MOUSE_OFF }).toEqual({ on: '\x1b[?1000h\x1b[?1006h', off: '\x1b[?1006l\x1b[?1000l' });
  });
});

describe('the key a click lands on', () => {
  it('a tab presses its digit, on its number or its name', () => {
    const h = FRAME[0];
    expect([keyAt(FRAME, col(h, '1 HOME'), 1), keyAt(FRAME, col(h, 'HOME', 3), 1), keyAt(FRAME, col(h, '3 4'), 1), keyAt(FRAME, col(h, 'chain'), 1), keyAt(FRAME, 1, 1)])
      .toEqual(['1', '1', '3', null, null]);
  });
  it('a hint presses its key, on the bracket or its label; a range or a pair does nothing', () => {
    const f = FRAME[6];
    expect([keyAt(FRAME, col(f, '[Enter]'), 7), keyAt(FRAME, col(f, 'open', 2), 7), keyAt(FRAME, col(f, 'verify'), 7), keyAt(FRAME, col(f, '[1-6]'), 7), keyAt(FRAME, col(f, 'NORMAL'), 7), keyAt(FRAME, col(f, 'chain'), 7)])
      .toEqual(['Enter', 'Enter', 'v', null, null, null]);
  });
  it('hints inside cards count, measured in cells (the em dash and box lines before them)', () => {
    expect([keyAt(FRAME, col(FRAME[4], '[s]'), 5), keyAt(FRAME, col(FRAME[4], 'first'), 5), keyAt(FRAME, col(FRAME[4], 'historical'), 5), keyAt(FRAME, col(FRAME[5], 'shows QR', 6), 6)])
      .toEqual(['s', 's', null, 'q']);
  });
  it('a label ends at a middle dot, so two hints on one line stay apart', () => {
    const l = FRAME[7];
    expect([keyAt(FRAME, col(l, 'Begin'), 8), keyAt(FRAME, col(l, '·'), 8), keyAt(FRAME, col(l, 'Quit'), 8)]).toEqual(['Enter', null, 'q']);
  });
  it('hints one space apart stay apart: a label ends at the next bracket', () => {
    const l = ' NORMAL  COMMAND   [w] swarm [h] hands [l] launch';
    expect([keyAt([l], col(l, 'swarm'), 1), keyAt([l], col(l, '[h]'), 1), keyAt([l], col(l, 'hands'), 1), keyAt([l], col(l, 'launch'), 1)]).toEqual(['w', 'h', 'h', 'l']);
  });
  it('a click off the frame, or before any frame, is nothing', () => {
    expect([keyAt(FRAME, 5, 40), keyAt([], 5, 1)]).toEqual([null, null]);
  });
});

describe('the frame the clicks are read against', () => {
  it('keeps the text of the last frame written, without its escapes', () => {
    recordFrame('\x1b[2K\x1b[1A\x1b[2K\x1b[G\x1b[1mTIMMY\x1b[22m   1 HOME\n\x1b[90m─────\x1b[39m\n');
    recordFrame('\x1b[?25l'); // no text: the frame stays
    expect(lastFrame()).toEqual(['TIMMY   1 HOME', '─────', '']);
  });
});
