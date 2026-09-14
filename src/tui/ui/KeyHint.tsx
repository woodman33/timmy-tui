// DESIGN.md §6 — key/label pair: `[g] approve`. Copy voice (§5.4): the label
// says what happens, plain lowercase verb. C1c: the key is structure (bold
// white), the label is grey-3 — weight, not a fourth grey, carries the pair.
import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';

export function KeyHint({ keys, label }: { keys: string; label: string }) {
  return (
    <Text>
      <Text bold color={theme.textPrimary}>[{keys}]</Text>
      <Text color={theme.textMuted}> {label}</Text>
    </Text>
  );
}
