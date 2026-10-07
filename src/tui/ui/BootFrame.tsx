// The monitor's first frame, drawn while the shell loads (BOOT, opentui-u4e9), shared by both boot
// paths in cli.tsx (C-11, row 27). It paints no ground and draws in the terminal's own text color,
// the primary role (B2), so it needs no measurement: it is up while the terminal is measured.
import React from 'react';
import { Box, Text } from 'ink';
import { MonitorScreen } from './MonitorScreen.js';

export function BootFrame({ head }: { head: string }): React.ReactElement {
  return (
    <MonitorScreen>
      {() => (
        <Box flexDirection="column">
          <Box>
            <Text bold>TIMMY</Text>
            <Text>{`   chain · ${head}`}</Text>
          </Box>
          <Text>assembling…</Text>
        </Box>
      )}
    </MonitorScreen>
  );
}
