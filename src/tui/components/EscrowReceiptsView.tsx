import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { readChain, verifyChain } from '../../utils/receipts.js';
import { theme } from '../theme.js';
import { PanelFrame, PaneFocusContext } from './PanelFrame.js';
import { BudgetList } from '../ui/BudgetList.js';
import { EmptyState } from '../ui/EmptyState.js';
import { truncateVisible } from '../utils/text.js';
import { useOpenReceipt } from './ReceiptDetail.js';

interface EscrowRow {
  escrow_id: string; state: string; ceiling_usd: number; drawn_usd: number;
  refund_usd?: number; qa_value?: number; merkle_root?: string;
}

const STATE_COLOR: Record<string, string> = {
  armed: theme.accent, locked: theme.warn, judged: theme.accent,
  settled: theme.accent, slashed: theme.danger
};

// v1.0.1 view [4]: clean ledger of live locks / refunds / slashes + the
// receipt chain with a Merkle/chain verify line. Read-only companion data.
export function EscrowReceiptsView({ paneFocus, width, height }: { paneFocus: number; width: number; height: number }) {
  const [escrows, setEscrows] = useState<EscrowRow[]>([]);
  const [chain, setChain] = useState<{ ok: boolean; count: number; brokenAt?: string }>({ ok: false, count: 0 });
  const [tail, setTail] = useState<{ subject: string; hash: string; status: string }[]>([]);

  useEffect(() => {
    const load = () => {
      try {
        const dir = join(process.cwd(), '.timmy', 'escrow');
        setEscrows(readdirSync(dir).filter(f => f.endsWith('.json'))
          .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
          .sort((a, b) => String(a.escrow_id).localeCompare(String(b.escrow_id))));
      } catch { setEscrows([]); }
      try {
        const v = verifyChain('runs');
        setChain({ ok: v.ok, count: v.count, brokenAt: v.brokenAt });
        setTail(readChain('runs').slice(-12).reverse().map(r => ({
          subject: String(r.subject ?? ''), hash: String(r.hash ?? '').slice(7, 15), status: String(r.status ?? '')
        })));
      } catch { /* chain unreadable */ }
    };
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, []);

  const half = Math.max(30, Math.floor(width / 2) - 2);
  const openReceipt = useOpenReceipt();
  const [selIdx, setSelIdx] = useState(0);
  // C1 (ui.audit 3f6b191b6): red is refusal/failed ONLY. Valid sealed = phosphor
  // [OK]; unverified = dim [—]; refused/failed = red [FAIL]. Sealed receipts carry
  // no status:'ok' field, so validity comes from the chain verify, not r.status.
  const rowState = (r: { hash: string; status: string }): 'ok' | 'unverified' | 'fail' => {
    if (r.status === 'failed' || r.status === 'refused' || r.status === 'denied') return 'fail';
    if (chain.ok) return 'ok';
    if (chain.brokenAt && chain.brokenAt.slice(7, 15) === r.hash) return 'fail';
    return 'unverified';
  };
  useInput((input, key) => {
    if (paneFocus !== 1) return;
    if (key.upArrow) { setSelIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelIdx(i => Math.min(Math.max(tail.length - 1, 0), i + 1)); return; }
    if (key.return && tail[selIdx]) openReceipt(tail[selIdx].hash);
  }, { isActive: paneFocus === 1 });
  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box flexGrow={1} flexDirection="column" paddingRight={1}>
        <PaneFocusContext.Provider value={paneFocus === 0}>
          <PanelFrame icon="●" title="ESCROW LEDGER" status={`${escrows.length} live`} hints={[]} explain="locks · draws · refunds · slashes">
            <Box flexDirection="column">
              {escrows.length === 0 && <EmptyState line="no escrows armed" action="dispatch a gated plan — [5]" />}
              <BudgetList
                items={escrows}
                render={e => (
                  <Text color={theme.textSecondary} wrap="truncate">
                    <Text color={STATE_COLOR[e.state] ?? theme.textMuted}>{e.state.padEnd(8)}</Text>
                    {' '}{truncateVisible(e.escrow_id, 12)} · ceil {e.ceiling_usd} · drawn {e.drawn_usd}
                    {` · refund=${(e.ceiling_usd - e.drawn_usd).toFixed(2)}`}
                    {e.qa_value !== undefined ? ` · qa ${e.qa_value}` : ''}
                  </Text>
                )}
              />
            </Box>
          </PanelFrame>
        </PaneFocusContext.Provider>
      </Box>
      <Box flexGrow={1} flexDirection="column" paddingLeft={1}>
        <PaneFocusContext.Provider value={paneFocus === 1}>
          <PanelFrame icon="◆" title="RECEIPT CHAIN" status={chain.ok ? `✓ ${chain.count}` : `× ${chain.brokenAt ?? 'broken'}`} statusKind={chain.ok ? 'completed' : 'failed'} hints={[{ key: 'Enter', label: 'open' }, { key: 'Esc', label: 'back' }]} explain="merkle + chain verify, newest first">
            <Box flexDirection="column">
              {tail.length === 0 && <EmptyState line="no receipts yet" action="run anything — it seals one" />}
              <BudgetList
                items={tail}
                render={(r, i) => {
                  const st = rowState(r);
                  const glyph = st === 'ok' ? '[OK]' : st === 'fail' ? '[FAIL]' : '[—]';
                  const gc = st === 'ok' ? theme.seal : st === 'fail' ? theme.danger : theme.textMuted;
                  const sel = i === selIdx;
                  return (
                    <Text color={sel ? theme.accent : st === 'fail' ? theme.danger : theme.textSecondary} wrap="truncate">
                      {sel ? '▸' : ' '}<Text bold color={gc}>{glyph}</Text>
                      {' '}{truncateVisible(`${r.hash} · ${r.subject}`, half - 10)}
                    </Text>
                  );
                }}
              />
              <Text color={chain.ok ? theme.accent : theme.danger} wrap="truncate">
                {chain.ok ? '[VERIFIED] ' : '[BROKEN] '}chain {chain.ok ? `ok · ${chain.count} receipts` : `at ${chain.brokenAt}`}
              </Text>
            </Box>
          </PanelFrame>
        </PaneFocusContext.Provider>
      </Box>
    </Box>
  );
}
