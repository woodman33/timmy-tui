import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { KeyHintBar, type KeyHint } from './KeyHintBar.js';
import { theme } from '../theme.js';
import { statusGlyph, type TimmyStatus } from './StatusGlyph.js';

interface PanelFrameProps {
  icon: string;
  title: string;
  status?: string;
  /** Semantic status from the single glyph map — same glyph/color everywhere. */
  statusKind?: TimmyStatus;
  statusColor?: string;
  explain?: string;
  hints: KeyHint[];
  /** v1.0.1 Active Pane Invariant; defaults to the PaneFocusContext value. */
  active?: boolean;
  children: React.ReactNode;
}

// The focused pane in a view provides this as true; every framed pane below
// it renders bright #7dcfff chrome, everyone else drops to muted #292e42.
export const PaneFocusContext = React.createContext<boolean>(true);

// Consistent chrome for every tab: 1px hairline border, title + live status
// strip, one-line plain-English explainer, content, contextual key hints.
// All column math derives from stdout dimensions — no hardcoded buffers, so
// split tmux panes and small viewports shrink gutters instead of wrapping
// box-drawing characters.
export function PanelFrame({ icon, title, status, statusKind, statusColor, explain, hints, active, children }: PanelFrameProps) {
  const cols = useStdout().stdout?.columns ?? 80;
  const gutter = cols >= 100 ? 2 : 1;
  const g = statusKind ? statusGlyph(statusKind) : null;
  const ctxActive = React.useContext(PaneFocusContext);
  const isActive = active ?? ctxActive;
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={isActive ? theme.focus : theme.borderMuted} paddingX={gutter}>
      {/* v1.0.5: title sits alone on the top edge; status stacks below so
          narrow cards never collide title with status */}
      <Box flexDirection="column" marginBottom={1} flexShrink={0}>
        <Text bold={isActive} color={isActive ? theme.focus : theme.brandDim} wrap="truncate">{isActive ? '◆ ' : '◇ '}{icon} {title}</Text>
        {g || status ? (
          <Text color={statusColor ?? (g ? g.color : theme.textSecondary)} wrap="truncate">
            {g ? `${g.glyph} ${g.label}` : ''}{g && status ? ' · ' : ''}{status ?? ''}
          </Text>
        ) : null}
        {explain ? <Text color={theme.textTertiary} wrap="truncate">{explain}</Text> : null}
      </Box>
      {children}
      <KeyHintBar hints={hints} />
    </Box>
  );
}
