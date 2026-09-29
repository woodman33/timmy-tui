import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

// Honest empty state: what this screen shows + the first action to take.
export function EmptyState({ lines, extra }: { lines: string[]; extra?: string }) {
  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
      {lines.map((l, i) => (
        <Text key={i} color={theme.textSecondary}>{l}</Text>
      ))}
      {extra ? <Text color={theme.textMuted}>{extra}</Text> : null}
    </Box>
  );
}
