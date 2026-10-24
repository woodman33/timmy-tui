/**
 * R4 (H110): the terminal Workbench's look, Timmy Homebrew (src/theme/tokens.ts). Since DESIGN.md §10 B10 (the operator's
 * palette of 2026-10-15): readable off-white text, labels a step quieter (#8E8E93), amber for the region that has the keyboard,
 * the active tab, the selection, the one primary next step, .intent and .predict and a decision that waits on a person (R7,
 * H150: commands, keys and key hints are in the text's colour), silver for places to go and for made-by-a-model, and amber
 * with ✕ and its word for failed or refused; green only for an observed live, passed or sealed state. No colour is chosen here:
 * every value is a token.
 * Colour never carries a meaning alone: each role's meaning is also in its words, and the focused region also has its
 * marker and a heavier border (src/workbench/frame.ts).
 *
 * R7 (H150; REMAINING-DEFECTS row 3, H147's R6 finding 1): how those colours reach the terminal (workbenchPalette). Before,
 * every colour was a hex for chalk, which wrote it exactly only with 24-bit colour and otherwise made its own 256-colour guess
 * (#FFFFFF text, #AFAFAF secondary, #5FFF00 green), and never the Timmy Homebrew profile's 16 slots the REPL and the monitor
 * use. Now:
 * - `truecolor` (COLORTERM=truecolor or 24bit): B10's colours exactly;
 * - `homebrew-slots`, `homebrew-basic`: the Timmy Homebrew profile is known (TIMMY_PALETTE=homebrew, or the terminal's own
 *   answer is that profile's, measured as the REPL measures it: src/term/probe.ts measureTerminal): text in the terminal's
 *   own foreground, the meanings in the profile's slots as DESIGN.md §10 B10 "The terminal" lists them (3 amber, 2 green,
 *   7 silver, 8 secondary grey); the structure and the selection's ground, which have no slot there, in the 256 colours'
 *   fixed grey ramp (238 is #444444, 236 #303030) where the terminal has 256 colours (`homebrew-slots`), else in slot 8
 *   with the selection inverted (`homebrew-basic`, a terminal of 16 colours such as tmux's default TERM=screen);
 * - `ansi256`: any other terminal of 256 colours: each colour's nearest of them by perceived difference (CIELAB ΔE76, the
 *   grey ramp counted: by plain RGB distance #8E8E93 would be 246);
 * - `basic`: a terminal of 16 colours whose palette is not known: chalk's own 16-colour reading of the hex, as before;
 * - `none`: no colour (the selection inverted; the roles keep their weight, words and marks).
 * src/workbench/run.ts sets chalk's level from the terminal's, so Ink writes exactly what the mode says.
 */
import type { ColorLevel } from '../term/capabilities.js';
import { blend, hexToRgb, isLight } from '../term/color.js';
import type { MeasuredColors } from '../term/palettes.js';
import { HOMEBREW, HOMEBREW_TERMINAL } from '../theme/tokens.js';
import type { Role, Seg } from './text.js';

export interface InkTextStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  underline?: boolean;
  inverse?: boolean;
  dimColor?: boolean;
}

/** How the Workbench's colours reach this terminal (the file's head says each). */
export type WorkbenchPalette = 'truecolor' | 'homebrew-slots' | 'homebrew-basic' | 'ansi256' | 'basic' | 'none';

const ROLE_COLOR: Readonly<Record<Role, string>> = {
  text: HOMEBREW.text,
  secondary: HOMEBREW.textSecondary,
  strong: HOMEBREW.text,
  // R7 (H150; B10 "Amber is exact"): a command, a key, a button in the text's colour; amber is `accent`, `focus`, `attention`
  // and `failure` only (src/workbench/text.ts Role)
  action: HOMEBREW.text,
  accent: HOMEBREW.accent,
  link: HOMEBREW.link,
  attention: HOMEBREW.attention,
  failure: HOMEBREW.failure,
  // R5 (H131): earned green only (src/workbench/text.ts Role 'live'); its word is always beside it
  live: HOMEBREW.live,
  ai: HOMEBREW.ai,
  border: HOMEBREW.lineStrong,
  focus: HOMEBREW.accent,
};

// ── the nearest of the 256 colours ─────────────────────────────────────────────

const CUBE = [0, 95, 135, 175, 215, 255];
/** xterm's colours 16 to 255 (the 6×6×6 cube, then the 24 greys); 0 to 15 are the terminal's own palette, never assumed. */
const XTERM_256: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  ...Array.from({ length: 216 }, (_, n) => [16 + n, [CUBE[Math.floor(n / 36)], CUBE[Math.floor(n / 6) % 6], CUBE[n % 6]]] as const),
  ...Array.from({ length: 24 }, (_, n) => [232 + n, [8 + 10 * n, 8 + 10 * n, 8 + 10 * n]] as const),
];

const linear = (c: number): number => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
/** sRGB to CIELAB (D65). */
function lab([r, g, b]: readonly [number, number, number]): [number, number, number] {
  const R = linear(r);
  const G = linear(g);
  const B = linear(b);
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const XTERM_LAB = XTERM_256.map(([n, rgb]) => [n, lab(rgb)] as const);

/** The xterm 256-colour index (16 to 255) nearest to `hex` by perceived difference (CIELAB ΔE76). */
export function nearest256(hex: string): number {
  const want = lab(hexToRgb(hex));
  let best = 16;
  let bestD = Number.POSITIVE_INFINITY;
  for (const [n, l] of XTERM_LAB) {
    const d = (l[0] - want[0]) ** 2 + (l[1] - want[1]) ** 2 + (l[2] - want[2]) ** 2;
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

// ── which colours this terminal gets ───────────────────────────────────────────

/** The slots Timmy's roles use under the profile (B10 "The terminal"), and its ground. */
const PROFILE_SLOTS = [2, 3, 7, 8] as const;
const near = (a: string | null | undefined, b: string): boolean => {
  if (!a) return false;
  const x = hexToRgb(a.toUpperCase());
  const y = hexToRgb(b.toUpperCase());
  return x.every((v, i) => Math.abs(v - y[i]) <= 3);
};

/**
 * Whether the terminal's colours are the Timmy Homebrew profile's: its ground, and the slots Timmy's roles use (2 green, 3
 * amber, 7 silver, 8 secondary grey), each within 3 steps a channel of the profile's (a terminal answers in 16 bits a channel).
 * TIMMY_PALETTE=homebrew gives exactly these (src/term/palettes.ts measuredFromPalette).
 */
export function isHomebrewProfile(m: MeasuredColors): boolean {
  if (!near(m.background, HOMEBREW_TERMINAL.background)) return false;
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack'] as const;
  return PROFILE_SLOTS.every((n) => near(m.slots[n], HOMEBREW_TERMINAL[names[n]]));
}

/** The colours this terminal gets, from its colour level and what Timmy measured of it (or was told: TIMMY_PALETTE). */
export function workbenchPalette(caps: { color: ColorLevel }, measured: MeasuredColors = { background: null, slots: {} }): WorkbenchPalette {
  if (caps.color <= 0) return 'none';
  if (caps.color >= 3) return 'truecolor';
  if (isHomebrewProfile(measured)) return caps.color >= 2 ? 'homebrew-slots' : 'homebrew-basic';
  return caps.color >= 2 ? 'ansi256' : 'basic';
}

// ── a role's colour in each mode ───────────────────────────────────────────────

/** Ink's names for the profile's slots (chalk: yellow 33, green 32, white 37, blackBright 90). */
const SLOT_NAME: Readonly<Record<number, string>> = { 2: 'green', 3: 'yellow', 7: 'white', 8: 'blackBright' };
/** Each role's slot under the profile; undefined: the terminal's own foreground (the profile's #F2EFE9). */
const ROLE_SLOT: Readonly<Record<Role, number | undefined>> = {
  text: undefined, strong: undefined, secondary: 8, action: undefined, accent: 3, focus: 3, attention: 3, failure: 3, live: 2, ai: 7, link: 7, border: undefined,
};

/** A role's colour for Ink in `palette` (undefined: the terminal's own foreground). */
function colourOf(role: Role, palette: WorkbenchPalette): string | undefined {
  const hex = ROLE_COLOR[role];
  switch (palette) {
    case 'truecolor':
    case 'basic':
      return hex;
    case 'ansi256':
      return `ansi256(${nearest256(hex)})`;
    case 'homebrew-slots':
    case 'homebrew-basic': {
      // structure has no slot of its own under the profile: the fixed grey ramp where the terminal has it, else slot 8
      if (role === 'border') return palette === 'homebrew-slots' ? `ansi256(${nearest256(hex)})` : SLOT_NAME[8];
      const slot = ROLE_SLOT[role];
      return slot === undefined ? undefined : SLOT_NAME[slot];
    }
    default:
      return undefined;
  }
}

/** The selection's ground in `palette`; null: the selection is inverted instead. */
function groundOf(palette: WorkbenchPalette): string | null {
  switch (palette) {
    case 'truecolor':
    case 'basic':
      return HOMEBREW.accentSoft;
    case 'ansi256':
    case 'homebrew-slots':
      return `ansi256(${nearest256(HOMEBREW.accentSoft)})`;
    default:
      return null;
  }
}

const hex = ([r, g, b]: readonly [number, number, number]): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/**
 * R11 (H167; step 1b): the composer's tinted ground (the playbook's `block` input, §17.2-17.3): the terminal's own background
 * with the text laid over it at 12% (a light one with black at 4%) when the terminal answered the colour probe (OSC 11:
 * src/term/probe.ts measureTerminal, or TIMMY_PALETTE), else the same blend over B10's canvas (#000000 → #1F1F1F). The
 * playbook's fallback is the bright-black slot (100m), but in the Timmy Homebrew profile that slot is the secondary grey
 * (#8E8E93): off-white on it measures 2.3:1, under the floor, so it is not used. On 256 colours a near-neutral tint takes the
 * grey ramp (the cube makes dark tints heavy); a terminal of 16 colours and NO_COLOR get no tint: the "› " and the cursor
 * mark the composer then.
 */
export function inputGround(palette: WorkbenchPalette, measured: MeasuredColors = { background: null, slots: {} }): string | null {
  if (palette === 'none' || palette === 'basic' || palette === 'homebrew-basic') return null;
  const bg = hexToRgb((measured.background ?? HOMEBREW.ground).toUpperCase());
  const t = isLight(bg) ? blend([0, 0, 0], bg, 0.04) : blend([255, 255, 255], bg, 0.12);
  if (palette === 'truecolor') return hex(t);
  const [r, g, b] = t;
  if (Math.max(r, g, b) - Math.min(r, g, b) < 16) return `ansi256(${232 + Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)))})`;
  return `ansi256(${nearest256(hex(t))})`;
}

/**
 * How a segment is drawn: its role's colour (none when the terminal shows no colour), weight and ground. `palette`: how the
 * colours reach this terminal (workbenchPalette; B10's hex, as before, when not given). `ground`: the composer's tint
 * (inputGround; its default, unmeasured, when not given).
 */
export function styleOf(s: Seg, colour: boolean, palette: WorkbenchPalette = 'truecolor', ground?: string | null): InkTextStyle {
  const role = s.role ?? 'text';
  const style: InkTextStyle = {};
  const shown = colour && palette !== 'none';
  // R5 (H131; the QA round's defect 11): on the selection's ground a quiet word takes the text's colour (grey on it measured
  // 3.88:1, under the 4.5:1 floor), and so does a bracket drawn in the border's grey
  if (shown) {
    const c = colourOf(s.selected && (role === 'secondary' || role === 'border') ? 'text' : role, palette);
    if (c) style.color = c;
  }
  if (s.bold || role === 'strong' || role === 'focus' || role === 'live') style.bold = true;
  if (s.underline) style.underline = true;
  if (s.inverse) style.inverse = true;
  // the selected row: the selection's ground with colour; inverted without it (its marker says it too)
  if (s.selected) {
    const g = shown ? groundOf(palette) : null;
    if (g) style.backgroundColor = g;
    else style.inverse = !style.inverse;
  } else if (s.block && shown) {
    // R11 (H167; step 1b): the composer's tinted row (none on a terminal that cannot show it: its "› " marks it)
    const g = ground === undefined ? inputGround(palette) : ground;
    if (g) style.backgroundColor = g;
  }
  return style;
}
