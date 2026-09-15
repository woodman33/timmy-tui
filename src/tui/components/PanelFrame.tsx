// DESIGN.md §6 — PanelFrame DELEGATES to the ui kit Card: one border-drawing
// implementation in the app (src/tui/ui/Card.tsx). Panels keep their
// hints/status APIs; the visual vocabulary lives in the kit.
import React from 'react';
import { KeyHintBar, type KeyHint } from './KeyHintBar.js';
import { statusGlyph, type TimmyStatus } from './StatusGlyph.js';
import { Card } from '../ui/Card.js';
import type { PillKind } from '../ui/Pill.js';

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
  overflow?: string;
  children?: React.ReactNode;
}

// The focused pane in a view provides this as true; every framed pane below
// it renders theme.lineFocus chrome, everyone else drops to theme.line.
export const PaneFocusContext = React.createContext<boolean>(true);

const pillKindFor = (kind?: TimmyStatus, live?: boolean): PillKind => {
  if (kind === 'failed') return 'danger';
  if (kind === 'completed') return 'accent'; // done is not sealed
  if (kind === 'running') return 'accent';
  if (kind === 'queued') return 'warn'; // declared: white, plain (C1b-2)
  if (kind === 'idle') return 'muted';
  return live ? 'accent' : 'muted';
};

export function PanelFrame({ icon, title, status, statusKind, statusColor, explain, hints, active, overflow, children }: PanelFrameProps) {
  const ctxActive = React.useContext(PaneFocusContext);
  const isActive = active ?? ctxActive;
  const g = statusKind ? statusGlyph(statusKind) : null;
  void statusColor; // kit owns colors; legacy prop kept for call-site compat
  const pill = status || g
    ? { kind: pillKindFor(statusKind, Boolean(status)), label: `${g ? g.glyph + ' ' : ''}${status ?? g?.label ?? ''}` }
    : undefined;
  return (
    <Card
      title={`${icon} ${title}`}
      focused={isActive}
      purpose={explain}
      pill={pill}
      overflow={overflow}
      flexGrow={1}
    >
      {children}
      <KeyHintBar hints={hints} />
    </Card>
  );
}
