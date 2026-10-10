/**
 * Round R4 (H55): the board's line about Timmy Canvas (the snapshot's and /board live's): whether the canvas is open on this
 * same project, and the typed command that changes it. The REPL checks the canvas (src/repl/canvas-project.ts); this module
 * only draws what it found, escaped, with no time in it (so the live board redraws only when the line itself changes).
 */
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import { esc, type Kit } from './board-kit.js';

/** What the board says about the canvas, in words, and the command that acts on it. */
export interface BoardCanvas {
  /** same: it shows this project; other: another one; none: no project named to it; off: not running; unknown: cannot say */
  tone: 'same' | 'other' | 'none' | 'off' | 'unknown';
  words: string;
  command?: string;
}

export function canvasLineHtml(c: BoardCanvas, k: Kit): string {
  return `<p class="canvas-line canvas-${esc(c.tone)}" id="canvas">${esc(c.words)}${c.command ? ` ${k.cmd(c.command)}` : ''}</p>`;
}

export const CANVAS_LINE_CSS = `
.canvas-line { margin: 0 0 14px; color: ${HOMEBREW.text}; font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.canvas-line .cmd { margin-left: 4px; }
`;
