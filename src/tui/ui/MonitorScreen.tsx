// C-11 (CHECKPOINTS row 27): the monitor's frame follows the terminal's width, resize included. It
// paints no ground (DESIGN.md §10 B2: the ground is the terminal palette's, on every Timmy surface).
import React from 'react';
import { useWindowSize } from 'ink';

export interface MonitorScreenProps {
  /** Draws the screen at the current width; called again after every resize. */
  children: (columns: number) => React.ReactNode;
}

export function MonitorScreen({ children }: MonitorScreenProps): React.ReactElement {
  const { columns } = useWindowSize();
  return <>{children(columns)}</>;
}
