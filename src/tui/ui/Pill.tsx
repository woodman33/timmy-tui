// DESIGN.md §6 — status pill. kind carries the ONLY meaning, painted by the law:
// seal = cryptographic proof (green) · danger = fail/refused (red) · accent =
// live/interactive (white, bold) · warn = queued/pending/not-yet (declared: white, plain) ·
// muted = idle (grey-3). Panels never colour pills directly.
import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';

export type PillKind = 'seal' | 'warn' | 'danger' | 'accent' | 'muted';

const KIND_COLOR: Record<PillKind, string> = {
  seal: theme.seal,
  warn: theme.textPrimary,
  danger: theme.danger,
  accent: theme.accent,
  muted: theme.textMuted,
};

export function Pill({ kind, label }: { kind: PillKind; label: string }) {
  return (
    <Text color={KIND_COLOR[kind]} bold={kind === 'seal' || kind === 'accent'}>
      [{label}]
    </Text>
  );
}
