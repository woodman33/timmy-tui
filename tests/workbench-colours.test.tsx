// R7 (H150; REMAINING-DEFECTS row 3, H147's R6 finding 1): the Workbench's colours without truecolor. Before, with no
// COLORTERM=truecolor (also with TIMMY_PALETTE=homebrew) chalk turned B10's hex into its own 256-colour guesses: #FFFFFF text
// (231), #AFAFAF secondary (145), #FFAF00 amber, #5FFF00 green (82); it never used the Timmy Homebrew profile's 16 slots,
// though the REPL and the monitor do. Now (src/workbench/theme.ts workbenchPalette, styleOf):
// - a terminal that draws 24-bit colour (COLORTERM=truecolor or 24bit): B10's colours exactly;
// - the Timmy Homebrew profile known (TIMMY_PALETTE=homebrew, or the colours the terminal answers are that profile's, as the
//   REPL measures them: src/term/probe.ts measureTerminal): text in the terminal's own foreground, the meanings in the
//   profile's slots as DESIGN.md §10 B10 "The terminal" lists them (3 amber, 2 green, 7 silver, 8 secondary grey), and the
//   structure and the selection's ground in the 256 colours' fixed grey ramp (238 #444444, 236 #303030) where the terminal
//   has 256 colours (16 only: structure in slot 8, the selection inverted);
// - any other terminal of 256 colours: the nearest of them by perceived difference (CIELAB ΔE), the grey ramp counted;
// - a terminal of 16 colours whose palette is not known: chalk's own 16-colour reading of the hex, as before.
// The bytes each role writes are read from what Ink itself prints, in each mode.
import React from 'react';
import chalk from 'chalk';
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { measuredFromPalette, TIMMY_HOMEBREW, TIMMY_NIGHT, type MeasuredColors } from '../src/term/palettes.js';
import { parseColorReplies } from '../src/term/probe.js';
import { HOMEBREW } from '../src/theme/tokens.js';
import type { Role, Seg } from '../src/workbench/text.js';
import { inputGround, isHomebrewProfile, nearest256, styleOf, workbenchPalette, type WorkbenchPalette } from '../src/workbench/theme.js';

const level = chalk.level;
afterEach(() => { chalk.level = level; cleanup(); });

const ROLES: Role[] = ['text', 'strong', 'secondary', 'action', 'accent', 'focus', 'attention', 'failure', 'live', 'ai', 'link', 'border'];

/** The bytes Ink prints for one segment, with chalk at `lv` (as the Workbench sets it from the terminal's colour level). */
function bytes(seg: Seg, palette: WorkbenchPalette, lv: 0 | 1 | 2 | 3): string {
  chalk.level = lv;
  const { lastFrame, unmount } = render(<Text {...styleOf(seg, true, palette)}>X</Text>);
  const out = lastFrame() ?? '';
  unmount();
  return out;
}
/** The SGR parameters written before the X. */
const sgr = (out: string): string => [...out.slice(0, out.indexOf('X')).matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]).join(' ');

/** An OSC 11 and OSC 4 answer, as a terminal writes it (16 bits a channel). */
const answer = (bg: string, slots: Record<number, string>): string => {
  const ch = (hex: string) => [1, 3, 5].map((i) => hex.slice(i, i + 2).repeat(2).toLowerCase()).join('/');
  return `\x1b]11;rgb:${ch(bg)}\x07${Object.entries(slots).map(([n, h]) => `\x1b]4;${n};rgb:${ch(h)}\x07`).join('')}\x1b[?62c`;
};

describe('the Workbench\'s colours without truecolor (R7 H150; H147\'s R6 finding 1)', () => {
  it('the nearest of the 256 colours by perceived difference (CIELAB ΔE), the grey ramp counted', () => {
    const want: Record<string, number> = {
      '#F2EFE9': 255, '#8E8E93': 245, '#FFB000': 214, '#28FE14': 46, '#00D700': 40, '#333333': 236, '#444444': 238, '#070707': 232, '#E8E4D9': 254, '#000000': 16,
    };
    for (const [hex, n] of Object.entries(want)) expect(nearest256(hex), hex).toBe(n);
    // (by plain RGB distance #8E8E93 would be 246, #949494: the perceived difference is the one used)
  });

  it('which colours this terminal gets: truecolor; the Homebrew profile, named or measured; else the nearest 256; else chalk\'s 16', () => {
    const none: MeasuredColors = { background: null, slots: {} };
    const homebrew = measuredFromPalette(TIMMY_HOMEBREW);
    expect(workbenchPalette({ color: 3 }, homebrew)).toBe('truecolor');
    expect(workbenchPalette({ color: 3 }, none)).toBe('truecolor');
    expect(workbenchPalette({ color: 2 }, homebrew)).toBe('homebrew-slots');
    expect(workbenchPalette({ color: 1 }, homebrew)).toBe('homebrew-basic');
    expect(workbenchPalette({ color: 2 }, none)).toBe('ansi256');
    expect(workbenchPalette({ color: 2 }, measuredFromPalette(TIMMY_NIGHT))).toBe('ansi256');
    expect(workbenchPalette({ color: 1 }, none)).toBe('basic');
    expect(workbenchPalette({ color: 0 }, homebrew)).toBe('none');
    // measured as the REPL measures it (the terminal's own answer): the profile's ground and slots 2, 3, 7 and 8
    const measured = parseColorReplies(answer('#000000', { 7: '#E8E4D9', 8: '#8E8E93', 1: '#FF5F56', 2: '#28FE14', 3: '#FFB000' }));
    expect(isHomebrewProfile(measured)).toBe(true);
    expect(workbenchPalette({ color: 2 }, measured)).toBe('homebrew-slots');
    // another profile with the same amber is not the Homebrew profile (its green and silver differ)
    const other = parseColorReplies(answer('#000000', { 7: '#D0D0D0', 8: '#6C6C6C', 2: '#33FF66', 3: '#FFB000' }));
    expect(isHomebrewProfile(other)).toBe(false);
    expect(workbenchPalette({ color: 2 }, other)).toBe('ansi256');
  });

  it('the bytes each role writes, in each mode (Ink\'s own output)', () => {
    // 24-bit: B10's colours exactly
    const truecolor: Record<string, string> = {
      text: '38;2;242;239;233', strong: '1 38;2;242;239;233', secondary: '38;2;142;142;147', action: '38;2;242;239;233', accent: '38;2;255;176;0', focus: '1 38;2;255;176;0',
      attention: '38;2;255;176;0', failure: '38;2;255;176;0', live: '1 38;2;40;254;20', ai: '38;2;232;228;217', link: '38;2;232;228;217', border: '38;2;68;68;68',
    };
    // the Homebrew profile's slots (text: the terminal's own foreground), structure in the fixed grey ramp
    const slots: Record<string, string> = {
      text: '', strong: '1', secondary: '90', action: '', accent: '33', focus: '1 33', attention: '33', failure: '33', live: '1 32', ai: '37', link: '37', border: '38;5;238',
    };
    // the profile on a 16-colour terminal: structure in slot 8
    const basicSlots: Record<string, string> = { ...slots, border: '90' };
    // the nearest of the 256
    const n256: Record<string, string> = {
      text: '38;5;255', strong: '1 38;5;255', secondary: '38;5;245', action: '38;5;255', accent: '38;5;214', focus: '1 38;5;214', attention: '38;5;214', failure: '38;5;214', live: '1 38;5;46', ai: '38;5;254', link: '38;5;254', border: '38;5;238',
    };
    for (const role of ROLES) {
      const seg: Seg = { text: 'X', role };
      expect(sgr(bytes(seg, 'truecolor', 3)), `truecolor ${role}`).toBe(truecolor[role]);
      expect(sgr(bytes(seg, 'homebrew-slots', 2)), `homebrew-slots ${role}`).toBe(slots[role]);
      expect(sgr(bytes(seg, 'homebrew-basic', 1)), `homebrew-basic ${role}`).toBe(basicSlots[role]);
      expect(sgr(bytes(seg, 'ansi256', 2)), `ansi256 ${role}`).toBe(n256[role]);
      // never chalk's own 256 guesses for B10's colours: 231 white, 145 grey, 82 green
      for (const m of ['homebrew-slots', 'ansi256'] as const) expect(sgr(bytes(seg, m, 2)), `${m} ${role}`).not.toMatch(/38;5;(231|145|82)\b/);
    }
    // the selection's ground: #333333 exactly; 236 (#303030) in the grey ramp; inverted where only 16 colours are; and a quiet
    // word on it takes the text's colour (grey on it is under the floor)
    const sel: Seg = { text: 'X', role: 'secondary', selected: true };
    expect(sgr(bytes(sel, 'truecolor', 3))).toBe('48;2;51;51;51 38;2;242;239;233');
    expect(sgr(bytes(sel, 'homebrew-slots', 2))).toBe('48;5;236');
    expect(sgr(bytes(sel, 'homebrew-basic', 1))).toBe('7');
    expect(sgr(bytes(sel, 'ansi256', 2))).toBe('48;5;236 38;5;255');
    // a terminal that shows no colour: no colour (the selection inverted, its marker says it too)
    expect(styleOf(sel, false)).toEqual({ inverse: true });
    expect(styleOf({ text: 'X', role: 'live' }, false)).toEqual({ bold: true });
  });

  it('R11 step 1b (H167): the composer\'s tint (inputGround): the measured background lightened by the playbook\'s blend, a light one darkened, B10\'s canvas when nothing answered; the grey ramp on 256 colours; none on 16 colours or without colour; a block segment carries it, a plain one does not', () => {
    // 24-bit: white at 12% over the measured black (#000000 → #1F1F1F); over the Night profile's own background; black at 4%
    // over a light one; the canvas when the terminal did not answer
    expect(inputGround('truecolor', measuredFromPalette(TIMMY_HOMEBREW))).toBe('#1F1F1F');
    expect(inputGround('truecolor', { background: '#FFFFFF', slots: {} })).toBe('#F5F5F5');
    expect(inputGround('truecolor')).toBe('#1F1F1F');
    expect(inputGround('truecolor', { background: '#1A2233', slots: {} })).toBe('#353D4B');
    // 256 colours: a near-neutral tint takes the grey ramp (232 #080808 … 255 #EEEEEE: #1F1F1F → 234)
    expect(inputGround('ansi256', measuredFromPalette(TIMMY_HOMEBREW))).toBe('ansi256(234)');
    expect(inputGround('homebrew-slots')).toBe('ansi256(234)');
    // 16 colours and no colour: no tint (the playbook's 100m slot is the profile's secondary grey, #8E8E93: off-white on it
    // is under the contrast floor, so it is not used; "› " and the cursor mark the composer)
    expect(inputGround('basic')).toBeNull();
    expect(inputGround('homebrew-basic')).toBeNull();
    expect(inputGround('none')).toBeNull();
    // a block segment is drawn on it (its own role's colour kept), a plain one is not; without colour nothing
    expect(styleOf({ text: '› ', role: 'accent', block: true }, true, 'truecolor', '#1F1F1F')).toEqual({ color: HOMEBREW.accent, backgroundColor: '#1F1F1F' });
    expect(styleOf({ text: 'x', role: 'text', block: true }, true, 'truecolor')).toEqual({ color: HOMEBREW.text, backgroundColor: '#1F1F1F' });
    expect(styleOf({ text: 'x', role: 'text' }, true, 'truecolor', '#1F1F1F')).toEqual({ color: HOMEBREW.text });
    expect(styleOf({ text: 'x', role: 'text', block: true }, true, 'none')).toEqual({});
    expect(styleOf({ text: 'x', role: 'text', block: true }, false)).toEqual({});
    // the bytes Ink writes for a tinted cell at 24-bit: the background's RGB
    chalk.level = 3;
    const { lastFrame, unmount } = render(<Text {...styleOf({ text: 'X', role: 'text', block: true }, true, 'truecolor', '#1F1F1F')}>X</Text>);
    expect(sgr(lastFrame() ?? '')).toContain('48;2;31;31;31');
    unmount();
  });

  it('the hex the 24-bit mode writes is B10\'s tokens (src/theme/tokens.ts), never chosen here', () => {
    expect(styleOf({ text: 'X', role: 'text' }, true, 'truecolor').color).toBe(HOMEBREW.text);
    expect(styleOf({ text: 'X', role: 'secondary' }, true, 'truecolor').color).toBe(HOMEBREW.textSecondary);
    expect(styleOf({ text: 'X', role: 'accent' }, true, 'truecolor').color).toBe(HOMEBREW.accent);
    // (R7 H150, B10 "Amber is exact": a command, a key, a button in the text's colour)
    expect(styleOf({ text: 'X', role: 'action' }, true, 'truecolor').color).toBe(HOMEBREW.text);
    expect(styleOf({ text: 'X', role: 'live' }, true, 'truecolor').color).toBe(HOMEBREW.live);
    expect(styleOf({ text: 'X', role: 'border' }, true, 'truecolor').color).toBe(HOMEBREW.lineStrong);
  });
});
