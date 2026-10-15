/**
 * R4 (H110): the terminal Workbench's look, Timmy Homebrew (src/theme/tokens.ts). Since DESIGN.md §10 B10 (the operator's
 * palette of 2026-10-15): readable off-white text, labels a step quieter (#8E8E93), amber for commands, keys, the region that
 * has the keyboard and a decision that waits on a person, silver for places to go and for made-by-a-model, and amber with ✕
 * and its word for failed or refused; green only for an observed live, passed or sealed state. No colour is chosen here:
 * every value is a token.
 * Colour never carries a meaning alone: each role's meaning is also in its words, and the focused region also has its
 * marker and a heavier border (src/workbench/frame.ts).
 */
import { HOMEBREW } from '../theme/tokens.js';
import type { Role, Seg } from './text.js';

export interface InkTextStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  underline?: boolean;
  inverse?: boolean;
  dimColor?: boolean;
}

const ROLE_COLOR: Readonly<Record<Role, string>> = {
  text: HOMEBREW.text,
  secondary: HOMEBREW.textSecondary,
  strong: HOMEBREW.text,
  action: HOMEBREW.accent,
  link: HOMEBREW.link,
  attention: HOMEBREW.attention,
  failure: HOMEBREW.failure,
  // R5 (H131): earned green only (src/workbench/text.ts Role 'live'); its word is always beside it
  live: HOMEBREW.live,
  ai: HOMEBREW.ai,
  border: HOMEBREW.lineStrong,
  focus: HOMEBREW.accent,
};

/** How a segment is drawn: its role's colour (none when the terminal shows no colour), weight and ground. */
export function styleOf(s: Seg, colour: boolean): InkTextStyle {
  const role = s.role ?? 'text';
  const style: InkTextStyle = {};
  if (colour) style.color = ROLE_COLOR[role];
  if (s.bold || role === 'strong' || role === 'focus' || role === 'live') style.bold = true;
  if (s.underline) style.underline = true;
  if (s.inverse) style.inverse = true;
  // the selected row: the selection's ground with colour; inverted without it (its marker says it too)
  if (s.selected) {
    if (colour) style.backgroundColor = HOMEBREW.accentSoft;
    else style.inverse = !style.inverse;
  }
  return style;
}
