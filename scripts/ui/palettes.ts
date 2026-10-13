import { TERMINAL_BASIC, TERMINAL_CLEAR_DARK, TIMMY_DAY, TIMMY_HOMEBREW, TIMMY_NIGHT, type TerminalPalette } from '../../src/term/palettes.js';

/** Palettes a capture can be measured or pictured under. `audited`: the operator's terminal as
 *  measured on 2026-10-04 (an unpainted #191919 ground). */
export const CAPTURE_PALETTES: Record<string, TerminalPalette> = {
  // Round R1: the default (DESIGN.md §10 B9), and the operator's own stock profile, gated like the rest.
  homebrew: TIMMY_HOMEBREW,
  'clear-dark': TERMINAL_CLEAR_DARK,
  night: TIMMY_NIGHT,
  day: TIMMY_DAY,
  basic: TERMINAL_BASIC,
  audited: { ...TIMMY_NIGHT, name: 'audited terminal (#191919 ground)', background: '#191919' },
};
