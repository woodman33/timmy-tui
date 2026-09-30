// Proof register — a hash is an evidence carrier (C1b-2): sealed=true is the
// checked state (✓ SEAL green, bold — cryptographically verified, never mere
// success); an unverified hash is constructed (● white glyph, muted digits).
// Hashes render truncated `abc123f8…` (full on focus).
import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';

export function HashChip({
  hash, sealed = false, full = false,
}: { hash: string; sealed?: boolean; full?: boolean }) {
  const shown = full || hash.length <= 9 ? hash : `${hash.slice(0, 8)}…`;
  return sealed ? (
    <Text color={theme.seal} bold>✓ {shown}</Text>
  ) : (
    <Text color={theme.textMuted}><Text color={theme.structure}>●</Text> {shown}</Text>
  );
}
