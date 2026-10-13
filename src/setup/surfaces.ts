/**
 * One way to open Timmy's three surfaces (round R4, H98), said the same everywhere: the REPL's first screen and the top of
 * /help, the board's top, the monitor. TIMMY STUDIO is Timmy Canvas (the tldraw workspace: `/studio`, the same code path as
 * `/canvas open`); the Control Room is `/room`; God's Eye View is `/overview`; `/board live` is the board in the browser
 * (the Control Room and God's Eye View as its sections, Studio as its /studio to copy: journey-2, it said "all three").
 *
 * The board's top (src/repl/board.ts) shows three links: Control Room and God's Eye View jump to their sections; Studio
 * is `/studio` as a copy chip with a short reason: the live board's act bridge runs only its allowlisted actions (stop,
 * run, observe, rebuild, vox, lesson, restore: src/repl/board-live.ts checkAction), and the canvas page needs the one-time
 * grant only the REPL's own `/canvas open` mints (src/repl/canvas-project.ts), which the board cannot give.
 */
import type { Kit } from '../repl/board-kit.js';
import type { Segment } from '../term/theme.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';

/** The one line (the brief's words). */
export const SURFACES_LINE = 'Studio /studio · Control Room /room · God\'s Eye View /overview · the board in your browser: /board live';

/** The line as lines no wider than `width`, broken only between its parts (never cut). */
export function surfacesLines(width: number, indent = ''): string[] {
  const parts = SURFACES_LINE.split(' · ');
  const out: string[] = [];
  let line = '';
  for (const p of parts) {
    const next = line ? `${line} · ${p}` : p;
    if (line && indent.length + next.length > width) { out.push(indent + line); line = p; } else line = next;
  }
  if (line) out.push(indent + line);
  return out;
}

/** The same lines for the REPL: each command (/studio, /room, /overview, /board live) strong, the words around it secondary. */
export function surfacesSegments(width: number, indent = ''): Segment[][] {
  return surfacesLines(width, indent).map((line) => line.split(/(\/[a-z]+(?: live)?)/).filter(Boolean)
    .map((text): Segment => ({ text, role: text.startsWith('/') ? 'strong' : 'secondary' })));
}

/** Why the board's Studio link is a command to copy (one short line on the board). */
export const STUDIO_BOARD_WHY = 'type it in the REPL: the board cannot give Timmy Studio\'s page its one-time grant';

/** The monitor's answer to /studio: it cannot mint the grant either, so it says exactly how. */
export const MONITOR_STUDIO_WORDS = 'Timmy Studio: in a terminal, run timmy and type /studio (the same as /canvas open). Only the REPL can give its page the one-time grant it needs; the monitor cannot.';

/** The monitor's answer to /setup: the guided setup asks in a terminal. */
export const MONITOR_SETUP_WORDS = 'Setup: leave the monitor (Ctrl+C) and run timmy init: it asks only what has no answer. The local model: timmy init --chat local --model <name> (free, no key). A model key: timmy init --chat openrouter (OpenRouter is paid; it asks for the key, hidden).';

/** The board's top: three links. A section the board does not show is its typed command to copy instead. */
export function surfacesHtml(k: Kit, have: { room: boolean; overview: boolean }): string {
  const jump = (label: string, id: string, cmd: string, present: boolean): string => (present
    ? `<a class="surface" href="#${id}" data-surface="${id}"><b>${label}</b></a>`
    : `<span class="surface" data-surface="${id}"><b>${label}</b> ${k.cmd(cmd)}</span>`);
  return [
    '<nav class="surfaces" aria-label="Timmy Studio, the Control Room and God\'s Eye View">',
    `<span class="surface" data-surface="studio"><b>Studio</b> ${k.cmd('/studio')} <span class="why">${STUDIO_BOARD_WHY}</span></span>`,
    jump('Control Room', 'room', '/room', have.room),
    jump('God&#39;s Eye View', 'overview', '/overview', have.overview),
    '</nav>',
  ].join('');
}

/** Their look (the board's tokens; no style attribute: the live board's policy allows none). */
export const SURFACES_CSS = `
.surfaces { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; margin: 0 0 18px; padding: 10px 12px; background: ${HOMEBREW.surface}; border: 1px solid ${HOMEBREW.line}; border-radius: 8px; }
.surfaces .surface { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; color: ${HOMEBREW.text}; }
.surfaces a.surface { color: ${HOMEBREW.link}; text-decoration: none; }
.surfaces a.surface:hover, .surfaces a.surface:focus-visible { text-decoration: underline; }
.surfaces b { font-weight: ${TYPE.weight.strong}; }
.surfaces .why { color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; }
`;
