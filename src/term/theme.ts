/**
 * The semantic map (DESIGN.md §10 B2–B5, playbook §16.5): roles become SGR codes for the 16 theme
 * colors. Before using a color, Timmy measures it against the real background; a color that misses
 * its floor is dropped and the role keeps its bold word and glyph, so meaning never rides on color.
 */
import type { TerminalCapabilities } from './capabilities.js';
import { blend, contrastRatio, hexToRgb, isLight } from './color.js';
import { glyphSet, type GlyphSet } from './glyphs.js';
import { truncate, visibleWidth } from './width.js';
import type { MeasuredColors } from './palettes.js';

export type Role =
  | 'primary' | 'secondary' | 'strong' | 'verified' | 'estimate' | 'failure' | 'ai' | 'rule' | 'diffAdd' | 'diffRemove';

export interface Segment {
  text: string;
  role?: Role;
}

export interface Theme {
  readonly caps: TerminalCapabilities;
  readonly glyphs: GlyphSet;
  /** SGR parameters for the input-row background, or null when there is no measured ground. */
  readonly tint: string | null;
  open(role: Role): string;
  close(role: Role): string;
}

const FLOOR = { text: 4.5, nonText: 3, neutralText: 7 } as const;

interface Style {
  bold: boolean;
  slot: number | null;
}

// Each colored role: its weight, its slot, and the contrast floor its slot must clear.
const ROLES: Record<Exclude<Role, 'primary' | 'secondary'>, { bold: boolean; slot: number | null; floor: number }> = {
  strong: { bold: true, slot: null, floor: 0 },
  verified: { bold: true, slot: 2, floor: FLOOR.text },
  estimate: { bold: false, slot: 3, floor: FLOOR.text },
  failure: { bold: true, slot: 1, floor: FLOOR.text },
  ai: { bold: false, slot: 5, floor: FLOOR.text },
  rule: { bold: false, slot: 8, floor: FLOOR.nonText },
  diffAdd: { bold: false, slot: 2, floor: FLOOR.text },
  diffRemove: { bold: false, slot: 1, floor: FLOOR.text },
};

const fgCode = (slot: number): number => (slot < 8 ? 30 + slot : 90 + slot - 8);

/** Whether `slot` clears `floor` on this ground; unknown colors are trusted (nothing to measure). */
function clears(measured: MeasuredColors, slot: number, floor: number): boolean {
  const fg = measured.slots[slot];
  if (!measured.background || !fg) return true;
  return contrastRatio(fg, measured.background) >= floor;
}

/** B3: gray if it clears 7:1, else white if it does, else the terminal's own text color. */
function secondarySlot(measured: MeasuredColors): number | null {
  if (!measured.background) return null;
  for (const slot of [8, 7]) {
    const fg = measured.slots[slot];
    if (fg && contrastRatio(fg, measured.background) >= FLOOR.neutralText) return slot;
  }
  return null;
}

function tintFor(caps: TerminalCapabilities, background: string | null): string | null {
  if (!background || caps.color < 2) return null;
  const bg = hexToRgb(background);
  const t = isLight(bg) ? blend([0, 0, 0], bg, 0.04) : blend([255, 255, 255], bg, 0.12);
  if (caps.color === 3) return `48;2;${t.join(';')}`;
  const [r, g, b] = t;
  if (Math.max(r, g, b) - Math.min(r, g, b) < 16) {
    const step = Math.round(((r + g + b) / 3 - 8) / 10);
    return `48;5;${232 + Math.min(23, Math.max(0, step))}`;
  }
  const q = (v: number): number => Math.round((v / 255) * 5);
  return `48;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}`;
}

/**
 * The palette slot each role is drawn in on this terminal, or null for the terminal's own text color:
 * primary never takes a slot, secondary is measured (B3), and a colored role whose slot misses its
 * floor on the measured ground is dropped. The REPL's theme and the monitor's output map share it.
 */
export function roleSlots(caps: Pick<TerminalCapabilities, 'color'>, measured: MeasuredColors = { background: null, slots: {} }): Record<Role, number | null> {
  const useColor = caps.color > 0;
  const slots = { primary: null, secondary: useColor ? secondarySlot(measured) : null } as Record<Role, number | null>;
  for (const [role, spec] of Object.entries(ROLES) as [Role, (typeof ROLES)[keyof typeof ROLES]][]) {
    slots[role] = useColor && spec.slot !== null && clears(measured, spec.slot, spec.floor) ? spec.slot : null;
  }
  return slots;
}

export function buildTheme(caps: TerminalCapabilities, measured: MeasuredColors = { background: null, slots: {} }): Theme {
  const styles = new Map<Role, Style>();
  const slots = roleSlots(caps, measured);
  styles.set('primary', { bold: false, slot: null });
  styles.set('secondary', { bold: false, slot: slots.secondary });
  for (const [role, spec] of Object.entries(ROLES) as [Role, (typeof ROLES)[keyof typeof ROLES]][]) {
    styles.set(role, { bold: spec.bold && caps.ansi, slot: slots[role] });
  }
  const open = (role: Role): string => {
    const s = styles.get(role)!;
    const params = [s.bold ? '1' : '', s.slot !== null ? String(fgCode(s.slot)) : ''].filter(Boolean);
    return params.length ? `\x1b[${params.join(';')}m` : '';
  };
  const close = (role: Role): string => {
    const s = styles.get(role)!;
    const params = [s.bold ? '22' : '', s.slot !== null ? '39' : ''].filter(Boolean);
    return params.length ? `\x1b[${params.join(';')}m` : '';
  };
  return { caps, glyphs: glyphSet(caps.unicode), tint: caps.color > 0 ? tintFor(caps, measured.background) : null, open, close };
}

/** Segments to one string. Each role closes with its own reset, never `\x1b[0m`, so a tint survives. */
export const serialize = (segments: Segment[], theme: Theme): string =>
  segments.map((s) => (s.role ? theme.open(s.role) + s.text + theme.close(s.role) : s.text)).join('');

/** Cut styled segments to `width` cells, ending in `ellipsis`; one row, never a wrap. */
export function fitSegments(segments: Segment[], width: number, ellipsis: string): Segment[] {
  const total = segments.reduce((n, s) => n + visibleWidth(s.text), 0);
  if (total <= width) return segments;
  const out: Segment[] = [];
  let used = 0;
  for (const s of segments) {
    const w = visibleWidth(s.text);
    if (used + w <= width - visibleWidth(ellipsis)) {
      out.push(s);
      used += w;
      continue;
    }
    out.push({ ...s, text: truncate(s.text, width - used, ellipsis) });
    break;
  }
  return out;
}

