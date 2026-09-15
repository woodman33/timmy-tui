// DESIGN.md §3.2 — the ONLY way to draw a border. Anatomy:
//   title row: focus glyph (◆/◇) + BOLD UPPER title + pill right-aligned
//   purpose line: textSecondary, ONE line
//   mandatory blank row, then content with 1-col padding
//   optional overflow line (never silent clipping)
// One card = one job. Max nesting depth 2 (inner regions use <SectionRule>).
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { Pill, type PillKind } from './Pill.js';

export interface CardProps {
  title: string;
  focused?: boolean;
  purpose?: string;
  pill?: { kind: PillKind; label: string };
  /** overflow line, e.g. "…and 12 more · [↓] scroll" — never clip silently */
  overflow?: string;
  children?: React.ReactNode;
  flexGrow?: number;
  flexBasis?: number | string;
  width?: number | string;
  height?: number | string;
  minHeight?: number;
}

// C1b-2: the card's diamonds are chrome (Active Pane Invariant), never evidence;
// the evidence glyphs (○ ● ✓ ◉ ◌ ×) are reserved — tests/evidence.test.ts proves the sets disjoint
export const CARD_GLYPHS = { focused: '◆', idle: '◇' } as const;

export function Card({
  title, focused = false, purpose, pill, overflow, children,
  flexGrow, flexBasis, width, height, minHeight,
}: CardProps) {
  const border = focused ? theme.lineFocus : theme.line;
  const glyph = focused ? CARD_GLYPHS.focused : CARD_GLYPHS.idle;
  const titleColor = focused ? theme.accent : theme.textSecondary;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={border}
      paddingX={1}
      flexGrow={flexGrow}
      flexBasis={flexBasis}
      width={width}
      height={height}
      minHeight={minHeight}
    >
      <Box justifyContent="space-between">
        <Text color={titleColor} bold={focused}>
          {glyph} {title.toUpperCase()}
        </Text>
        {pill ? <Pill kind={pill.kind} label={pill.label} /> : null}
      </Box>
      {purpose ? <Text color={theme.textSecondary}>{purpose}</Text> : null}
      <Box height={1} />
      <Box flexDirection="column" flexGrow={1}>{children}</Box>
      {overflow ? <Text dimColor color={theme.textMuted}>{overflow}</Text> : null}
    </Box>
  );
}
