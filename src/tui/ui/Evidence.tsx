// The evidence mark (ORDER ui-v3-t9r2, C1b-2): one glyph, chosen by the state,
// painted by the law. Refusal is not an evidence state — it is the REFUSE
// accent — and renders as × red so a refused row never masquerades as evidence.
import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';
import { evidenceLook, type EvidenceState } from '../evidence.js';

export function Evidence({ state, label }: { state: EvidenceState | 'refused'; label?: string }) {
  if (state === 'refused') return <Text color={theme.refuse}>{`×${label ? ` ${label}` : ''}`}</Text>;
  const look = evidenceLook(state);
  return <Text color={look.color} bold={look.bold} dimColor={look.dim}>{`${look.glyph}${label ? ` ${label}` : ''}`}</Text>;
}

/** The glyph alone, for fixed-width cells. */
export const evidenceGlyph = (state: EvidenceState | 'refused'): string => (state === 'refused' ? '×' : evidenceLook(state).glyph);
