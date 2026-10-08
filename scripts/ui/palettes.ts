import { TERMINAL_BASIC, TIMMY_DAY, TIMMY_NIGHT, type TerminalPalette } from '../../src/term/palettes.js';

/** Palettes a capture can be measured or pictured under. `audited`: the operator's terminal as
 *  measured on 2026-10-04 (an unpainted #191919 ground). */
export const CAPTURE_PALETTES: Record<string, TerminalPalette> = {
  night: TIMMY_NIGHT,
  day: TIMMY_DAY,
  basic: TERMINAL_BASIC,
  audited: { ...TIMMY_NIGHT, name: 'audited terminal (#191919 ground)', background: '#191919' },
};
