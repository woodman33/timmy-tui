// WALNUT counterflow chat surface (work order p12; DESIGN.md §3 layout law:
// header one line, left = act / right = evidence; §2.3 accent = interaction,
// seal = proof only; §5.4 copy voice). Spine: PROMPT→PLAN→LANES→RECEIPTS→
// PROOF; the lit stage is accent, PROOF earns seal only when the chain has
// sealed. Model chip always names the active upstream — no silent switching.
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { Conversation } from './Conversation.js';
import { ReceiptRain } from './ReceiptRain.js';
import { readChain } from '../../utils/receipts.js';
import { theme } from '../theme.js';
import type { Agent } from '../../agent/core.js';
import { ViewportContext } from '../layout.js';

const SPINE = ['PROMPT', 'PLAN', 'LANES', 'RECEIPTS', 'PROOF'] as const;

export function ChatSurface({ agent, keys }: { agent: Agent; keys: 'dispatcher' | 'local' }) {
  const { w, h } = React.useContext(ViewportContext);
  const [prov, setProv] = useState<string>('none');
  const [model, setModel] = useState<string>('');
  const [sealed, setSealed] = useState(false);

  useEffect(() => {
    const t = setInterval(() => {
      const a = agent as unknown as { activeProvider?: string; config?: { model?: string } };
      setProv(String(a.activeProvider ?? 'none'));
      setModel(prov === 'ollama' ? 'ollama/local' : String(a.config?.model ?? 'openrouter'));
      setSealed(readChain('runs').length > 0);
    }, 500);
    return () => clearInterval(t);
  }, [agent, prov]);

  const rainW = Math.max(26, Math.floor(w * 0.38));

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* thin single-line header: lit stage + spine + model chip (§3) */}
      <Box flexShrink={0}>
        <Text wrap="truncate">
          {SPINE.map((s, i) => (
            <Text key={s}>
              {i > 0 && <Text color={theme.textMuted}>─</Text>}
              {s === 'PROOF' && sealed
                ? <Text bold color={theme.textPrimary}> {s} </Text>
                : s === 'PROMPT'
                  ? <Text bold color={theme.accent}> {s} </Text>
                  : <Text color={theme.textMuted}> {s} </Text>}
            </Text>
          ))}
          <Text color={theme.textMuted}>{'  ·  '}</Text>
          <Text color={theme.accent}>[{prov === 'ollama' ? '⌂ ' : ''}{model}]</Text>
        </Text>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={1} flexDirection="column" paddingRight={1}>
          <Conversation agent={agent} keys={keys} />
        </Box>
        {/* §3: inner regions use rules/whitespace, never nested borders */}
        <Box width={rainW} flexShrink={0} flexDirection="column" paddingLeft={2}>
          <Text color={theme.textMuted} wrap="truncate">RECEIPT RAIN · live</Text>
          <ReceiptRain height={Math.max(8, h - 4)} />
        </Box>
      </Box>
    </Box>
  );
}
