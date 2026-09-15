import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export interface IntegrationPresence { id: string; name: string; installedAdapter: boolean }

/** Presence is deliberately a neutral filesystem observation. No native probe
 * or model is run to paint the UI; readiness belongs to a particular receipt. */
export function IntegrationStatus({ entries, compact = false, muted = false }: {
  entries: IntegrationPresence[]; compact?: boolean; muted?: boolean;
}) {
  const found = entries.filter(entry => entry.installedAdapter).length;
  const featured = ['openhands', 'viser', 'mcap', 'cosmos'];
  const displayed = [...entries].sort((a, b) => {
    const order = (id: string) => featured.includes(id) ? featured.indexOf(id) : featured.length;
    return order(a.id) - order(b.id);
  }).slice(0, 4);
  if (compact) return <Text color={theme.textMuted} wrap="truncate">ADAPTERS {found}/{entries.length} found ≠ ready · vision integrations list</Text>;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={muted ? theme.textMuted : theme.textSecondary} wrap="truncate">ADAPTERS · {found}/{entries.length} found · readiness unassessed</Text>
      <Text color={muted ? theme.textMuted : theme.textSecondary} wrap="truncate">{displayed.map(entry => `${entry.installedAdapter ? '•' : '○'} ${entry.id}`).join('  ')}{entries.length > 4 ? `  +${entries.length - 4}` : ''}</Text>
      <Text color={theme.textMuted} wrap="truncate">Inspect: timmy vision integrations list</Text>
    </Box>
  );
}
