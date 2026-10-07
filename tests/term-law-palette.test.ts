import { describe, expect, it } from 'vitest';
import visualLaw from '../lanes/visual/tokens.json' with { type: 'json' };
import { lawPalette } from '../src/term/law-palette.js';
import { measuredFromPalette, TERMINAL_BASIC, TIMMY_DAY, TIMMY_NIGHT, type MeasuredColors } from '../src/term/palettes.js';
import { roleSlots } from '../src/term/theme.js';

// C-11 under B2 (row 28): the monitor is written in the law's colors and reaches the terminal as the
// palette's 16 colors. Each law color stands for a role of the semantic map; grounds are never painted.
const LAW: Record<string, string> = Object.fromEntries(Object.entries(visualLaw.color).map(([k, v]) => [k, v.value]));
const rgb = (hex: string): string => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';');
const fg = (name: string): string => `\x1b[38;2;${rgb(LAW[name])}m`;
const bg = (name: string): string => `\x1b[48;2;${rgb(LAW[name])}m`;
const UNKNOWN: MeasuredColors = { background: null, slots: {} };
const mapper = (measured: MeasuredColors) => lawPalette(LAW, roleSlots({ color: 3 }, measured));
const night = mapper(measuredFromPalette(TIMMY_NIGHT));
const day = mapper(measuredFromPalette(TIMMY_DAY));

describe('law colors to the palette', () => {
  it('white is the terminal\'s own text color, and no ground or surface is ever painted', () => {
    expect(night(`${fg('white')}TIMMY\x1b[39m`)).toBe('\x1b[39mTIMMY\x1b[39m');
    for (const name of Object.keys(LAW)) expect(night(`${bg(name)} x\x1b[49m`), name).toBe('\x1b[49m x\x1b[49m');
  });
  it('secondary text (grey-3) is measured: white on Night, gray on Day, the terminal\'s text color when unknown (B3)', () => {
    expect([night(fg('grey-3')), day(fg('grey-3')), mapper(UNKNOWN)(fg('grey-3'))]).toEqual(['\x1b[37m', '\x1b[90m', '\x1b[39m']);
  });
  it('rules take slot 8 and the four meanings take their own slots', () => {
    expect(['grey-2', 'seal', 'seal-dim', 'refuse', 'predict', 'generated'].map((n) => night(fg(n))))
      .toEqual(['\x1b[90m', '\x1b[32m', '\x1b[32m', '\x1b[31m', '\x1b[33m', '\x1b[35m']);
  });
  it('a slot that misses its floor on the measured ground is dropped; the glyph and word keep the meaning', () => {
    const basic = mapper(measuredFromPalette(TERMINAL_BASIC));
    expect([basic(fg('seal')), basic(fg('refuse'))]).toEqual(['\x1b[39m', '\x1b[31m']);
  });
  it('other attributes in the same sequence stay; a color that is not the law passes unchanged', () => {
    expect(night(`\x1b[1;${fg('seal').slice(2, -1)};${bg('black').slice(2, -1)}mok`)).toBe('\x1b[1;32;49mok');
    expect(night('\x1b[38;2;1;2;3mx\x1b[7mInverse\x1b[2J')).toBe('\x1b[38;2;1;2;3mx\x1b[7mInverse\x1b[2J');
  });
});
