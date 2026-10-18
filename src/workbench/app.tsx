/**
 * R4 (H110): the Workbench as an Ink app (Ink 7, React 19, as the monitor). It draws the frame the controller composes
 * (src/workbench/screen.ts: every row exactly the terminal's width) and hands every key and mouse report to the controller.
 */
import React, { useEffect, useReducer } from 'react';
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { parseMouse } from '../tui/mouse.js';
import type { Controller } from './controller.js';
import { styleOf, type WorkbenchPalette } from './theme.js';

export interface WorkbenchAppProps {
  controller: Controller;
  /** the terminal shows colour */
  colour: boolean;
  /** R7 (H150): how the colours reach this terminal (src/workbench/theme.ts workbenchPalette); B10's hex when not given */
  palette?: WorkbenchPalette;
  /** a test's size (ink-testing-library's terminal has none of its own) */
  size?: { columns: number; rows: number };
}

export function WorkbenchApp({ controller, colour, palette, size }: WorkbenchAppProps): React.ReactElement {
  const win = useWindowSize();
  const columns = size?.columns ?? win.columns ?? 80;
  const rows = size?.rows ?? win.rows ?? 24;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => controller.subscribe(redraw), [controller]);
  useInput((input, key) => {
    const m = parseMouse(input);
    if (m) { controller.mouse(m); return; }
    controller.key(input, key);
  });
  // R4 lead (2026-10-12): the terminal marks a paste (bracketed paste, which this turns on while the Workbench runs), so pasted
  // text reaches the controller apart from typed keys: never taken as keys
  usePaste((text) => controller.paste(text));
  const f = controller.frame(columns, rows);
  return (
    <Box flexDirection="column">
      {f.screen.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line.map((s, j) => <Text key={j} {...styleOf(s, colour, palette)}>{s.text}</Text>)}
        </Text>
      ))}
    </Box>
  );
}
