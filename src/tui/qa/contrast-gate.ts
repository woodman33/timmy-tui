// Contrast gate for captured terminal frames. Floors are WCAG 2.x: 4.5:1 for text, 3:1 for
// non-text UI (rules, borders, icons, spinners), and 7:1 for neutral (grey or white) text, which
// DESIGN.md B3 makes Timmy's law for secondary text. Accents keep the 4.5:1 floor.
import type { FrameCell } from './ansi-frame.js';
import { contrastRatio } from '../../term/color.js';

export { contrastRatio, relativeLuminance } from '../../term/color.js';

export const GATE_FLOORS = { text: 4.5, nonText: 3, neutralText: 7 } as const;

export type GateRule = 'text' | 'non-text' | 'neutral-text';
export type GlyphKind = 'space' | 'text' | 'non-text';

export interface GateViolation {
  readonly rule: GateRule;
  readonly row: number;
  readonly col: number;
  readonly text: string;
  readonly fg: string;
  readonly bg: string;
  readonly ratio: number;
  readonly floor: number;
}

export interface GateReport {
  readonly pass: boolean;
  /** Same-colored stretches of glyphs that were measured. */
  readonly runs: number;
  readonly violations: readonly GateViolation[];
}

interface Run { row: number; col: number; end: number; text: string; fg: string; bg: string; kind: GlyphKind }

// Box drawing, blocks and geometric shapes; symbols and dingbats (✓ ✖ ⚠ ◉); braille spinner frames.
const NON_TEXT_RANGES: ReadonlyArray<readonly [number, number]> = [[0x2500, 0x25ff], [0x2600, 0x27bf], [0x2800, 0x28ff]];
const NEUTRAL_CHROMA = 24;

export function glyphKind(char: string): GlyphKind {
  if (char.trim() === '') return 'space';
  const cp = char.codePointAt(0) ?? 0;
  return NON_TEXT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 'non-text' : 'text';
}

function isNeutral(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return Math.max(...c) - Math.min(...c) < NEUTRAL_CHROMA;
}

function toRuns(cells: readonly FrameCell[]): Run[] {
  const runs: Run[] = [];
  let current: Run | undefined;
  for (const cell of cells) {
    const kind = glyphKind(cell.char);
    if (kind === 'space') continue;
    if (current && current.row === cell.row && current.fg === cell.fg && current.bg === cell.bg && current.kind === kind) {
      current.text += ' '.repeat(Math.max(0, cell.col - current.end)) + cell.char;
      current.end = cell.col + cell.width;
      continue;
    }
    current = { row: cell.row, col: cell.col, end: cell.col + cell.width, text: cell.char, fg: cell.fg, bg: cell.bg, kind };
    runs.push(current);
  }
  return runs;
}

/** Measures every glyph run in a frame against the floors; any violation fails the frame. */
export function gateFrame(cells: readonly FrameCell[], floors: typeof GATE_FLOORS = GATE_FLOORS): GateReport {
  const runs = toRuns(cells);
  const violations: GateViolation[] = [];
  for (const run of runs) {
    const ratio = contrastRatio(run.fg, run.bg);
    const rule: GateRule | undefined =
      run.kind === 'non-text' ? (ratio < floors.nonText ? 'non-text' : undefined)
        : ratio < floors.text ? 'text'
          : isNeutral(run.fg) && ratio < floors.neutralText ? 'neutral-text' : undefined;
    if (!rule) continue;
    const floor = rule === 'text' ? floors.text : rule === 'non-text' ? floors.nonText : floors.neutralText;
    violations.push({ rule, row: run.row, col: run.col, text: run.text, fg: run.fg, bg: run.bg, ratio: Math.round(ratio * 100) / 100, floor });
  }
  return { pass: violations.length === 0, runs: runs.length, violations };
}
