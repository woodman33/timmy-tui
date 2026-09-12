import React, { createContext, useContext, useMemo } from 'react';
import { Box, Text } from 'ink';
import { readChain } from '../../utils/receipts.js';
import { theme } from '../theme.js';
import { Card } from '../ui/Card.js';

// C2 (ui.audit 3f6b191b6): receipt detail reachable from any receipt list via
// select + Enter; Esc returns. Context avoids prop-threading through Layout.
export const ReceiptOpenContext = createContext<(hash: string) => void>(() => {});
export const useOpenReceipt = () => useContext(ReceiptOpenContext);

export function ReceiptDetail({ hash }: { hash: string }) {
  const rec = useMemo(() => {
    try {
      const chain = readChain('runs');
      const idx = chain.findIndex(r => String(r.hash ?? '').startsWith('sha256_' + hash) || String(r.hash ?? '').slice(7, 15) === hash);
      if (idx < 0) return null;
      return { rec: chain[idx], prev: idx > 0 ? chain[idx - 1] : null };
    } catch { return null; }
  }, [hash]);
  if (!rec) {
    return (
      <Box position="absolute" top={2} left={20} backgroundColor={theme.surfaceRaised} paddingX={1} flexDirection="column" width={56}>
        <Card title="RECEIPT DETAIL" focused purpose="[Esc] back">
          <Text color={theme.textMuted}>receipt {hash} not found in chain</Text>
        </Card>
      </Box>
    );
  }
  const h = String(rec.rec.hash ?? '');
  const ph = rec.prev ? String(rec.prev.hash ?? '') : '';
  return (
    <Box position="absolute" top={2} left={20} backgroundColor={theme.surfaceRaised} paddingX={1} flexDirection="column" width={56}>
      <Card title="RECEIPT DETAIL" focused purpose="[Esc] back">
        <Text bold color={theme.seal}>{h}</Text>
        <Text color={theme.textSecondary}>subject {String(rec.rec.subject ?? '—')}</Text>
        <Text color={theme.textSecondary}>kind {String(rec.rec.kind ?? '—')} · policy {String(rec.rec.policy ?? '—')}</Text>
        <Box height={1} />
        <Text color={theme.textPrimary}>
          prev {ph ? ph.slice(7, 15) : '(genesis)'} → this {h.slice(7, 15)}
        </Text>
      </Card>
    </Box>
  );
}
