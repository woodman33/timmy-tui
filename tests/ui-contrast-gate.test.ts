import { describe, expect, it } from 'vitest';
import { parseAnsiFrame, TIMMY_DAY, TIMMY_NIGHT, type TerminalPalette } from '../src/tui/qa/ansi-frame.js';
import { contrastRatio, gateFrame } from '../src/tui/qa/contrast-gate.js';

// Negative control, fixed before the gate existed (DOCTRINE §12). These are the colors the
// 2026-10-04 audit measured on the operator's terminal: the app never paints its ground, so text
// sits on the terminal's own #191919. grey-3 labels #8A8A8A (5.1:1), dimColor facts as rendered
// #3D3D3C (1.6:1), grey-2 card borders #3A3A3A (1.6:1). Expected: FAIL on all three rules.
const AUDITED_TERMINAL: TerminalPalette = { ...TIMMY_NIGHT, name: 'audited terminal', background: '#191919' };
const OLD_FRAME = [
  '\x1b[38;2;138;138;138mstatus · 3 lanes idle\x1b[39m',
  '\x1b[38;2;61;61;60mprev genesis → this 00a2b1b6\x1b[39m',
  '\x1b[38;2;58;58;58m╭──────────╮\x1b[39m',
].join('\n');

// Positive control: lines from the Cockpit prototype in the Timmy Night palette. Expected: PASS.
const NEW_FRAME = [
  '\x1b[1mTIMMY\x1b[22m 2.0.0',
  '\x1b[37m~/timmy/launch-video\x1b[39m',
  '\x1b[1;32m✓ RECEIPT 0142\x1b[22;39m signed and verified',
  '\x1b[90m──────────\x1b[39m',
  '\x1b[1;31m✖ Error:\x1b[22;39m the voiceover lane stopped',
  '\x1b[35m◉ Generated\x1b[39m storyboard',
  '\x1b[48;2;31;31;31m\x1b[39m › Make a 20-second storyboard\x1b[K\x1b[49m',
].join('\n');

describe('contrastRatio', () => {
  it('matches the WCAG 2.x formula', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#8A8A8A', '#191919')).toBeCloseTo(5.1, 1);
    expect(contrastRatio('#6C6C6C', '#000000')).toBeCloseTo(4.0, 1);
  });
});

describe('parseAnsiFrame', () => {
  it('resolves 16-color, 256-color and truecolor foregrounds through the palette', () => {
    const cells = parseAnsiFrame('\x1b[31mA\x1b[91mB\x1b[38;5;196mC\x1b[38;2;1;2;3mD\x1b[39mE', TIMMY_NIGHT);
    expect(cells.map((c) => c.fg)).toEqual(['#FF3B3B', '#FF6B6B', '#FF0000', '#010203', '#FFFFFF']);
    expect(cells.every((c) => c.bg === '#000000')).toBe(true);
  });

  it('resolves backgrounds, resets and inverse', () => {
    const cells = parseAnsiFrame('\x1b[41mA\x1b[48;5;232mB\x1b[0mC\x1b[7mD\x1b[27mE', TIMMY_NIGHT);
    expect(cells.map((c) => c.bg)).toEqual(['#FF3B3B', '#080808', '#000000', '#FFFFFF', '#000000']);
    expect(cells[3]?.fg).toBe('#000000');
  });

  it('renders dim as the foreground blended halfway to the background, cleared by 22', () => {
    const cells = parseAnsiFrame('\x1b[2mA\x1b[22mB', TIMMY_NIGHT);
    expect(cells[0]?.fg).toBe('#808080');
    expect(cells[0]?.dim).toBe(true);
    expect(cells[1]?.fg).toBe('#FFFFFF');
  });

  it('brightens bold 16-color text only when the palette says bold is bright', () => {
    expect(parseAnsiFrame('\x1b[1;31mA', TIMMY_NIGHT)[0]?.fg).toBe('#FF3B3B');
    expect(parseAnsiFrame('\x1b[1;31mA', { ...TIMMY_NIGHT, boldIsBright: true })[0]?.fg).toBe('#FF6B6B');
  });

  it('places cells by display width and ignores cursor and OSC 8 sequences', () => {
    const cells = parseAnsiFrame('日x\x1b[K\x1b]8;;https://example.test\x1b\\y\x1b]8;;\x1b\\\nz', TIMMY_DAY);
    expect(cells.map((c) => [c.char, c.row, c.col])).toEqual([['日', 0, 0], ['x', 0, 2], ['y', 0, 3], ['z', 1, 0]]);
    expect(cells[0]?.fg).toBe('#111111');
  });
});

describe('gateFrame', () => {
  it('fails the audited frame on all three rules (negative control)', () => {
    const report = gateFrame(parseAnsiFrame(OLD_FRAME, AUDITED_TERMINAL));
    expect(report.pass).toBe(false);
    const byRule = Object.fromEntries(report.violations.map((v) => [v.rule, v]));
    expect(byRule['neutral-text']).toMatchObject({ row: 0, fg: '#8A8A8A', bg: '#191919', floor: 7 });
    expect(byRule['neutral-text']?.ratio).toBeCloseTo(5.1, 1);
    expect(byRule['text']).toMatchObject({ row: 1, fg: '#3D3D3C', floor: 4.5 });
    expect(byRule['non-text']).toMatchObject({ row: 2, fg: '#3A3A3A', floor: 3 });
    expect(report.violations).toHaveLength(3);
  });

  it('passes the prototype frame (positive control)', () => {
    const report = gateFrame(parseAnsiFrame(NEW_FRAME, TIMMY_NIGHT));
    expect(report.violations).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.runs).toBeGreaterThan(6);
  });

  it('holds accent text to the 4.5:1 floor, not the neutral 7:1 rule', () => {
    const red = gateFrame(parseAnsiFrame('\x1b[31mrefused\x1b[39m', { ...TIMMY_NIGHT, red: '#C02020' }));
    expect(red.violations.map((v) => v.rule)).toEqual(['text']);
    expect(gateFrame(parseAnsiFrame('\x1b[35mgenerated\x1b[39m', TIMMY_NIGHT)).pass).toBe(true);
  });

  it('does not measure a tinted row of spaces', () => {
    expect(gateFrame(parseAnsiFrame('\x1b[48;2;20;20;20m      \x1b[49m', TIMMY_NIGHT)).runs).toBe(0);
  });
});
