import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '../src/term/color.js';
import { theme } from '../src/tui/theme.js';
import { modeBadgeStyle } from '../src/tui/components/ShellChrome.js';
import React from 'react';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import { parseAnsiFrame, TIMMY_DAY } from '../src/tui/qa/ansi-frame.js';
import visualLaw from '../lanes/visual/tokens.json' with { type: 'json' };
import { lawPalette } from '../src/term/law-palette.js';
import { measuredFromPalette, TERMINAL_BASIC, TIMMY_NIGHT, type MeasuredColors, type TerminalPalette } from '../src/term/palettes.js';
import { roleSlots } from '../src/term/theme.js';
import { BootFrame } from '../src/tui/ui/BootFrame.js';

// C-11: `timmy watch`, today's full-screen shell, restyled to the law. The before-capture (C-0c and
// 05:51 today) failed on two bindings: grey-3 labels at 5.09:1 and grey-2 rules at 1.55:1 on the
// audited #191919 ground. Under B2 (row 28) the monitor emits the palette's 16 colors, so what is
// measured is the color a terminal shows for each token: on Timmy Night and Day as installed, and on
// the audited terminal, whose palette the monitor could not measure. Floors: neutral text 7:1,
// colored text 4.5:1, lines 3:1.
const AUDITED = { ...TIMMY_NIGHT, name: 'audited', background: '#191919' };
const MEASURED: Array<[TerminalPalette, MeasuredColors]> = [TIMMY_NIGHT, TIMMY_DAY, TERMINAL_BASIC].map((p) => [p, measuredFromPalette(p)]);
const CASES: Array<[TerminalPalette, MeasuredColors]> = [...MEASURED, [AUDITED, { background: null, slots: {} }]];
const LAW: Record<string, string> = Object.fromEntries(Object.entries(visualLaw.color).map(([k, v]) => [k, v.value]));
/** The color `palette` shows for a token after the monitor's output map, and the ground under it. */
function shown(token: keyof typeof theme, palette: TerminalPalette, measured: MeasuredColors): [string, string] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme[token].slice(i, i + 2), 16));
  const out = lawPalette(LAW, roleSlots({ color: 3 }, measured))(`\x1b[38;2;${r};${g};${b}mx\x1b[39m`);
  const cell = parseAnsiFrame(out, palette)[0];
  return [cell.fg, cell.bg];
}

describe('the monitor\'s colors, as a terminal shows them', () => {
  it('every text token reads at 7:1 or better on Night, Day and the audited terminal', () => {
    for (const [palette, measured] of CASES) {
      for (const token of ['textPrimary', 'textSecondary', 'textMuted', 'accent', 'warn', 'structure'] as const) {
        expect(contrastRatio(...shown(token, palette, measured)), `${token} on ${palette.name}`).toBeGreaterThanOrEqual(7);
      }
    }
  });
  it('rules read at 3:1 or better, measured or not', () => {
    for (const [palette, measured] of CASES) {
      expect(contrastRatio(...shown('line', palette, measured)), `line on ${palette.name}`).toBeGreaterThanOrEqual(3);
    }
  });
  it('the four meanings read at 4.5:1 or better wherever the terminal was measured; a slot that misses is dropped', () => {
    for (const [palette, measured] of MEASURED) {
      for (const token of ['seal', 'refuse', 'predict', 'generated'] as const) {
        expect(contrastRatio(...shown(token, palette, measured)), `${token} on ${palette.name}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // macOS Terminal Basic: its green (3.1:1) and yellow (2.9:1) fail on white, so seal and predict
    // fall back to the terminal's text color; the glyph and the word keep the meaning.
    expect(['seal', 'predict'].map((t) => shown(t as 'seal', TERMINAL_BASIC, measuredFromPalette(TERMINAL_BASIC))[0])).toEqual(['#000000', '#000000']);
  });
  it('the first-run wordmark has no dim row (dim is banned)', () => {
    const src = readFileSync('src/tui/Onboarding.tsx', 'utf8');
    const at = src.indexOf('WORDMARK.map');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).not.toMatch(/dimColor/);
  });
  it('telemetry never writes to the terminal from inside the full-screen app (it printed over the frame)', () => {
    expect(readFileSync('src/tui/hooks/useTelemetryBridge.ts', 'utf8')).not.toMatch(/console\.(error|log|warn)\(/);
  });
});

const monitorSources = (dir = 'src/tui', out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'attic' && e !== 'qa') monitorSources(p, out); }
    else if (/\.(ts|tsx)$/.test(e) && e !== 'color-contract.ts') out.push(p);
  }
  return out;
};

describe('the monitor after the law (C-11, second part)', () => {
  it('draws no dim text anywhere (B3); dim measured 5.23:1 on the audited ground', () => {
    const dim = monitorSources().filter((p) => /dimColor/.test(readFileSync(p, 'utf8')));
    expect(dim).toEqual([]);
  });
  it('the mode badge is inverse video, so it reads in any palette and paints no color of its own (B2)', () => {
    expect((['NORMAL', 'INSERT', 'CHAT'] as const).map((mode) => modeBadgeStyle(mode)))
      .toEqual([{ inverse: true, bold: false }, { inverse: true, bold: true }, { inverse: true, bold: true }]);
    for (const p of [TIMMY_NIGHT, TIMMY_DAY]) expect(contrastRatio(p.background, p.foreground), p.name).toBeGreaterThanOrEqual(7);
  });
  it('never resets the terminal (ESC c wiped the scrollback); it draws in its own screen', () => {
    const src = readFileSync('cli.tsx', 'utf8');
    expect(src).not.toMatch(/\\x1Bc|\\x1bc|\\u001bc/i);
    expect(src).toMatch(/enterAltScreen\(\)/);
  });
});

// C-11 (row 27): the boot frame is one component for both boot paths, drawn like the shell after it:
// no painted ground (B2). A sentinel ground shows any cell that carries a background of its own.
describe('the boot frame', () => {
  it('shows the chain head and paints no ground', () => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const { lastFrame, unmount } = render(React.createElement(BootFrame, { head: 'e247ea44' }));
      const frame = lastFrame() ?? '';
      unmount();
      const sentinel = { ...TIMMY_DAY, name: 'sentinel', background: '#FE01FE' };
      const plain = frame.replace(/\x1b\[[0-9;:]*m/g, '');
      expect({
        text: plain.includes('chain · e247ea44') && plain.includes('assembling…'),
        painted: parseAnsiFrame(frame, sentinel).filter((c) => c.bg !== '#FE01FE').length,
      }).toEqual({ text: true, painted: 0 });
    } finally {
      chalk.level = level;
    }
  });
  it('cli.tsx draws that one frame in both of its boot paths', () => {
    const src = readFileSync('cli.tsx', 'utf8');
    expect(src).not.toMatch(/assembling…/);
    expect(src.match(/createElement\(BootFrame/g)?.length).toBe(2);
  });
});
