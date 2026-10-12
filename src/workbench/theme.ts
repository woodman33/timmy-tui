/**
 * R4 (H110): the terminal Workbench's look, Timmy Homebrew (src/theme/tokens.ts, DESIGN.md §10 B9): readable off-white text,
 * labels a step quieter, Homebrew green for commands, keys and the region that has the keyboard, blue for places to go, amber
 * only for a decision that waits on a person, red for failed or refused. No colour is chosen here: every value is a token.
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
  ai: HOMEBREW.ai,
  border: HOMEBREW.lineStrong,
  focus: HOMEBREW.accent,
};

/** How a segment is drawn: its role's colour (none when the terminal shows no colour), weight and ground. */
export function styleOf(s: Seg, colour: boolean): InkTextStyle {
  const role = s.role ?? 'text';
  const style: InkTextStyle = {};
  if (colour) style.color = ROLE_COLOR[role];
  if (s.bold || role === 'strong' || role === 'focus') style.bold = true;
  if (s.underline) style.underline = true;
  if (s.inverse) style.inverse = true;
  // the selected row: the selection's ground with colour; inverted without it (its marker says it too)
  if (s.selected) {
    if (colour) style.backgroundColor = HOMEBREW.accentSoft;
    else style.inverse = !style.inverse;
  }
  return style;
}
