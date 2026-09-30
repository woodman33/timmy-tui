// FORGE glass (p13; DESIGN.md §2.3 seal = proof only, §3 one card one job,
// §3.4 density via BudgetList, §6 kit only). Read-only: the sheet rendered
// from the ledger — gen.result receipts grouped by slot_id. No controls,
// no spend; the chain is the source of truth (decisions.md D5).
import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '../tui/ui/Card.js';
import { BudgetList } from '../tui/ui/BudgetList.js';
import { readChain, measuredCostUsd, declaredUnknownCostUsd } from '../utils/receipts.js';
import { theme } from '../tui/theme.js';

interface GenRec { hash: string; sources?: { slot_id?: string; local?: boolean }[]; cost_usd?: number; cost_measured?: boolean; via?: string; ms?: number; output_sha256?: string }

export function ForgePanel({ width }: { width: number }) {
  const gens = readChain('runs').filter(r => r.kind === 'gen.result') as unknown as GenRec[];
  const bySlot = new Map<string, GenRec[]>();
  for (const g of gens) {
    const id = g.sources?.[0]?.slot_id ?? 'slot-unpinned';
    bySlot.set(id, [...(bySlot.get(id) ?? []), g]);
  }
  const groups = [...bySlot.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  // evidence-rule accounting: declared-unknown placeholders are counted, never summed
  const totalCost = gens.reduce((s, g) => s + measuredCostUsd(g), 0);
  const totalUnknown = gens.reduce((s, g) => s + declaredUnknownCostUsd(g), 0);
  return (
    <Card
      title="FORGE — SHEET FROM LEDGER"
      purpose="read-only · gen.result grouped by slot_id · chain is truth"
      pill={{ kind: 'muted', label: `${gens.length} GENS` }}
      overflow={groups.length > 7 ? `…and ${groups.length - 7} more slots in the chain` : undefined}
      width={width}
    >
      {groups.length === 0 && (
        <Text color={theme.textMuted}>no gens yet — TIMMY_FORGE=1 timmy gen --sheet src/forge/sample-sheet.tldr.json --stub</Text>
      )}
      <BudgetList
        items={groups}
        render={([slot, list]) => {
          const last = list[list.length - 1];
          const local = last.sources?.[0]?.local === true;
          const slotCost = list.reduce((s, g) => s + measuredCostUsd(g), 0);
          const slotUnknown = list.reduce((s, g) => s + declaredUnknownCostUsd(g), 0);
          return (
            <Box flexDirection="column">
              <Text wrap="truncate">
                <Text bold color={theme.textPrimary}>{slot}</Text>
                <Text color={theme.textSecondary}>{'  '}{list.length} gen{list.length > 1 ? 's' : ''} · {last.via ?? '?'} · {local ? 'local' : 'remote'}</Text>
              </Text>
              <Text color={theme.textMuted} wrap="truncate">
                {'  '}<Text color={theme.seal}>{String(last.output_sha256 ?? '').slice(7, 15)}…</Text> · ${ slotCost.toFixed(2) }{slotUnknown ? ` (+${slotUnknown} declared-unknown)` : ''} · {last.ms ?? 0}ms
              </Text>
            </Box>
          );
        }}
      />
      <Text color={theme.textMuted}>total ${totalCost.toFixed(2)}{totalUnknown ? ` (+${totalUnknown} declared-unknown)` : ''} · every fill pinned slot_id into its receipts (D5)</Text>
    </Card>
  );
}
