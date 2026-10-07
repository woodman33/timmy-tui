// Parses one captured terminal frame (tmux `capture-pane -e -p`) into cells carrying the colors a
// terminal with `palette` would paint. Only SGR changes color; every other escape is skipped.
import { visibleWidth } from '../utils/text.js';

import { SLOT_NAMES, type TerminalPalette } from '../../term/palettes.js';

export { TIMMY_DAY, TIMMY_NIGHT, type TerminalPalette } from '../../term/palettes.js';

/** One painted cell: where it sits, what it shows, and the resolved colors (#RRGGBB). */
export interface FrameCell {
  readonly row: number;
  readonly col: number;
  readonly char: string;
  readonly width: number;
  readonly fg: string;
  readonly bg: string;
  readonly bold: boolean;
  readonly dim: boolean;
}

type Color = { readonly kind: 'default' } | { readonly kind: 'index'; readonly index: number } | { readonly kind: 'rgb'; readonly hex: string };
interface Pen { fg: Color; bg: Color; bold: boolean; dim: boolean; inverse: boolean }

const DEFAULT_COLOR: Color = { kind: 'default' };
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
const freshPen = (): Pen => ({ fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, bold: false, dim: false, inverse: false });
const byte = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
const rgbHex = (r: number, g: number, b: number): string => `#${byte(r)}${byte(g)}${byte(b)}`;
const channels = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The color an xterm-compatible terminal shows for a 256-color index under `palette`. */
export function indexedColor(index: number, palette: TerminalPalette): string {
  if (index < 16) return palette[SLOT_NAMES[index]].toUpperCase();
  if (index < 232) {
    const i = index - 16;
    return rgbHex(CUBE_LEVELS[Math.floor(i / 36)], CUBE_LEVELS[Math.floor(i / 6) % 6], CUBE_LEVELS[i % 6]);
  }
  const level = 8 + 10 * (index - 232);
  return rgbHex(level, level, level);
}

/** `fg` moved `amount` of the way toward `bg`; this is how xterm.js paints SGR 2 (dim). */
function blend(fg: string, bg: string, amount: number): string {
  const [fr, fgG, fb] = channels(fg);
  const [br, bgG, bb] = channels(bg);
  return rgbHex(fr + (br - fr) * amount, fgG + (bgG - fgG) * amount, fb + (bb - fb) * amount);
}

function resolve(color: Color, fallback: string, palette: TerminalPalette, brighten: boolean): string {
  if (color.kind === 'rgb') return color.hex;
  if (color.kind === 'index') return indexedColor(brighten && color.index < 8 ? color.index + 8 : color.index, palette);
  return fallback.toUpperCase();
}

/** Applies one SGR parameter list to the pen. Handles both `38;2;r;g;b` and `38:2::r:g:b` forms. */
function applySgr(params: string, pen: Pen): void {
  const groups = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < groups.length; i++) {
    const sub = groups[i].split(':').map((v) => (v === '' ? NaN : Number(v)));
    const code = sub[0];
    if (code === 38 || code === 48) {
      let color: Color | undefined;
      if (sub.length > 1) {
        const values = sub.filter((v) => !Number.isNaN(v));
        if (sub[1] === 5) color = { kind: 'index', index: values[2] };
        else if (sub[1] === 2) color = { kind: 'rgb', hex: rgbHex(...(values.slice(-3) as [number, number, number])) };
      } else if (groups[i + 1] === '5') {
        color = { kind: 'index', index: Number(groups[i + 2]) };
        i += 2;
      } else if (groups[i + 1] === '2') {
        color = { kind: 'rgb', hex: rgbHex(Number(groups[i + 2]), Number(groups[i + 3]), Number(groups[i + 4])) };
        i += 4;
      }
      if (color) pen[code === 38 ? 'fg' : 'bg'] = color;
      continue;
    }
    if (code === 0 || Number.isNaN(code)) Object.assign(pen, freshPen());
    else if (code === 1) pen.bold = true;
    else if (code === 2) pen.dim = true;
    else if (code === 22) { pen.bold = false; pen.dim = false; }
    else if (code === 7) pen.inverse = true;
    else if (code === 27) pen.inverse = false;
    else if (code >= 30 && code <= 37) pen.fg = { kind: 'index', index: code - 30 };
    else if (code >= 90 && code <= 97) pen.fg = { kind: 'index', index: code - 90 + 8 };
    else if (code === 39) pen.fg = DEFAULT_COLOR;
    else if (code >= 40 && code <= 47) pen.bg = { kind: 'index', index: code - 40 };
    else if (code >= 100 && code <= 107) pen.bg = { kind: 'index', index: code - 100 + 8 };
    else if (code === 49) pen.bg = DEFAULT_COLOR;
  }
}

/** Index just past an escape sequence starting at `start` (CSI, OSC, or a two-byte escape). */
function skipEscape(text: string, start: number, pen: Pen): number {
  const kind = text[start + 1];
  if (kind === '[') {
    let end = start + 2;
    while (end < text.length && !(text.charCodeAt(end) >= 0x40 && text.charCodeAt(end) <= 0x7e)) end++;
    if (text[end] === 'm') applySgr(text.slice(start + 2, end), pen);
    return end + 1;
  }
  if (kind === ']') {
    let end = start + 2;
    while (end < text.length && text[end] !== '\x07' && !(text[end] === '\x1b' && text[end + 1] === '\\')) end++;
    return text[end] === '\x07' ? end + 1 : end + 2;
  }
  return start + 2;
}

/** Every visible cell of `text`, positioned by display width, with colors resolved under `palette`. */
export function parseAnsiFrame(text: string, palette: TerminalPalette): FrameCell[] {
  const cells: FrameCell[] = [];
  const pen = freshPen();
  let row = 0;
  let col = 0;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '\x1b') { i = skipEscape(text, i, pen); continue; }
    if (ch === '\n') { row++; col = 0; i++; continue; }
    if (ch === '\r') { col = 0; i++; continue; }
    const char = String.fromCodePoint(text.codePointAt(i) ?? 0);
    i += char.length;
    const width = visibleWidth(char);
    if (width === 0) continue;
    let fg = resolve(pen.fg, palette.foreground, palette, pen.bold && palette.boldIsBright === true);
    let bg = resolve(pen.bg, palette.background, palette, false);
    if (pen.inverse) [fg, bg] = [bg, fg];
    if (pen.dim) fg = blend(fg, bg, 0.5);
    cells.push({ row, col, char, width, fg, bg, bold: pen.bold, dim: pen.dim });
    col += width;
  }
  return cells;
}
