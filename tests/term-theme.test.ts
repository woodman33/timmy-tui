import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../src/term/capabilities.js';
import { measuredFromPalette, TERMINAL_BASIC, TIMMY_DAY, TIMMY_NIGHT } from '../src/term/palettes.js';
import { buildTheme, fitSegments, serialize, type Role } from '../src/term/theme.js';

// The semantic map (DESIGN.md §10 B2–B5): Timmy emits only the 16 theme colors plus one computed
// input tint, measures the colors it is about to use against the real background, and keeps every
// meaning in a glyph or word so dropping a color never drops the meaning.
const TTY = { isTTY: true, columns: 80, rows: 24 };
const PIPE = { isTTY: false };
const capsFor = (env: Record<string, string>, stdout = TTY) => detectCapabilities({ env, stdin: TTY, stdout, stderr: TTY });
const TRUECOLOR = capsFor({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' });
const COLOR256 = capsFor({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' });
const night = buildTheme(TRUECOLOR, measuredFromPalette(TIMMY_NIGHT));
const day = buildTheme(TRUECOLOR, measuredFromPalette(TIMMY_DAY));
const unknown = buildTheme(TRUECOLOR);
const opens = (t: ReturnType<typeof buildTheme>, roles: Role[]) => roles.map((r) => t.open(r));

describe('secondary text (B3: measured, dim banned)', () => {
  it('uses white on dark and gray on light, picking the first that clears 7:1', () => {
    expect(night.open('secondary')).toBe('\x1b[37m');
    expect(day.open('secondary')).toBe('\x1b[90m');
  });
  it("uses the terminal's own text color when it cannot measure", () => {
    expect(unknown.open('secondary')).toBe('');
    expect(buildTheme(TRUECOLOR, measuredFromPalette(TERMINAL_BASIC)).open('secondary')).toBe('');
  });
});

describe('roles', () => {
  it('emits the 16 theme colors with glyph-carrying weights', () => {
    expect(opens(night, ['primary', 'strong', 'verified', 'estimate', 'failure', 'ai', 'rule', 'diffAdd', 'diffRemove'])).toEqual([
      '', '\x1b[1m', '\x1b[1;32m', '\x1b[33m', '\x1b[1;31m', '\x1b[35m', '\x1b[90m', '\x1b[32m', '\x1b[31m',
    ]);
    expect([night.close('verified'), night.close('estimate'), night.close('strong'), night.close('primary')]).toEqual([
      '\x1b[22;39m', '\x1b[39m', '\x1b[22m', '',
    ]);
  });
  it('drops a color that fails its floor on this terminal and keeps the bold word', () => {
    // macOS Terminal "Basic": green #00A600 is 3.3:1 and yellow #999900 is 3.0:1 on white.
    const basic = buildTheme(TRUECOLOR, measuredFromPalette(TERMINAL_BASIC));
    expect(opens(basic, ['verified', 'estimate', 'failure', 'ai', 'rule'])).toEqual(['\x1b[1m', '', '\x1b[1;31m', '\x1b[35m', '\x1b[90m']);
  });
  it("drops Night's violet on the operator's audited #191919 ground (4.15:1) and keeps the glyph and word", () => {
    const audited = buildTheme(TRUECOLOR, { ...measuredFromPalette(TIMMY_NIGHT), background: '#191919' });
    expect(opens(audited, ['ai', 'verified', 'failure', 'secondary'])).toEqual(['', '\x1b[1;32m', '\x1b[1;31m', '\x1b[37m']);
  });
  it('keeps bold but no color under NO_COLOR, and emits nothing at all into a pipe', () => {
    const noColor = buildTheme(capsFor({ TERM: 'xterm-256color', NO_COLOR: '1' }), measuredFromPalette(TIMMY_NIGHT));
    expect(opens(noColor, ['verified', 'estimate', 'secondary', 'rule'])).toEqual(['\x1b[1m', '', '', '']);
    const piped = buildTheme(capsFor({ TERM: 'xterm-256color' }, PIPE), measuredFromPalette(TIMMY_NIGHT));
    expect(opens(piped, ['verified', 'strong', 'failure'])).toEqual(['', '', '']);
  });
});

describe('input tint (computed from the real background)', () => {
  it('blends 12% white into dark grounds and 4% black into light ones', () => {
    expect(night.tint).toBe('48;2;31;31;31');
    expect(day.tint).toBe('48;2;245;245;245');
  });
  it('uses the 232-255 gray ramp on 256-color terminals', () => {
    expect(buildTheme(COLOR256, measuredFromPalette(TIMMY_NIGHT)).tint).toBe('48;5;234');
    expect(buildTheme(COLOR256, measuredFromPalette(TIMMY_DAY)).tint).toBe('48;5;255');
  });
  it('has no tint without a measured ground, with 16 colors, or under NO_COLOR', () => {
    expect(unknown.tint).toBe(null);
    expect(buildTheme(capsFor({ TERM: 'xterm' }), measuredFromPalette(TIMMY_NIGHT)).tint).toBe(null);
    expect(buildTheme(capsFor({ TERM: 'xterm-256color', NO_COLOR: '1' }), measuredFromPalette(TIMMY_NIGHT)).tint).toBe(null);
  });
});

describe('serialize', () => {
  const line = [{ text: '✓ RECEIPT 0142', role: 'verified' as const }, { text: ' signed and verified' }];
  it('closes each role with its own reset, never a full reset that would erase a tint', () => {
    const out = serialize(line, night);
    expect(out).toBe('\x1b[1;32m✓ RECEIPT 0142\x1b[22;39m signed and verified');
    expect(out).not.toContain('\x1b[0m');
  });
  it('is plain text in a pipe', () => {
    const piped = buildTheme(capsFor({ TERM: 'xterm-256color' }, PIPE), measuredFromPalette(TIMMY_NIGHT));
    expect(serialize(line, piped)).toBe('✓ RECEIPT 0142 signed and verified');
  });
});

describe('fitSegments', () => {
  it('cuts styled segments to a display width with the ellipsis, never wrapping', () => {
    const segs = [{ text: '  Themes     ', role: 'secondary' as const }, { text: '/very/long/path/to/assets/themes' }];
    expect(fitSegments(segs, 24, '…')).toEqual([{ text: '  Themes     ', role: 'secondary' }, { text: '/very/long…' }]);
    expect(fitSegments(segs, 80, '…')).toEqual(segs);
    expect(fitSegments([{ text: '日本語のテロップ', role: 'strong' as const }], 7, '…')).toEqual([{ text: '日本語…', role: 'strong' }]);
  });
});

