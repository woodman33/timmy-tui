import React from 'react';
import { Box, Text } from 'ink';
import { footerHintsShellShort, whichKeyGroupsShell, type ShellMode, type ShellTab } from '../keymap.js';
import { theme } from '../theme.js';

// TUI REDESIGN (spec §02/§07) — the footer and which-key overlay render FROM
// the keymap object; nothing here is a hand-typed hint string.
// FIX 4 (director): hints fit BY CONSTRUCTION — measure the fixed segments,
// then keep whole tokens from the left until the budget is spent (dropping
// from the right). A token is never split; the line never wraps.
export function ShellFooter({ mode, tab, chainOk, chainCount, busLive, width = 120, model }: {
  mode: ShellMode; tab: ShellTab; chainOk: boolean; chainCount: number; busLive: boolean; width?: number; model?: string;
}) {
  const badge = mode === 'NORMAL' ? theme.seal : theme.warn; // INSERT/CHAT badge = human present = orange
  const badgeSeg = ` ${mode} `;
  // SPEC §02: the CHAT footer names the sovereign model from policy
  const tabSeg = mode === 'CHAT' ? ` sovereign · ${model ?? '—'}   ` : ` ${tab}   `;
  const chainSeg = `  chain ${chainOk ? '✓' : '—'} ${chainCount}`;
  const busSeg = `  bus ${busLive ? '●' : '○'}`;
  const budget = width - (badgeSeg.length + tabSeg.length + chainSeg.length + busSeg.length);
  const tokens = footerHintsShellShort(mode, tab).split('  ');
  const kept: string[] = [];
  let used = 0;
  for (const t of tokens) {
    const add = (kept.length ? 2 : 0) + t.length;
    if (used + add > budget) break; // drop from the right, whole tokens only
    kept.push(t);
    used += add;
  }
  return (
    <Box>
      <Text backgroundColor={badge} color={theme.ground}>{badgeSeg}</Text>
      <Text color={theme.textMuted}>{tabSeg}{kept.join('  ')}</Text>
      <Text color={theme.seal}>{chainSeg}</Text>
      <Text color={theme.textMuted}>{busSeg}</Text>
    </Box>
  );
}

export function WhichKeyOverlay({ mode, tab }: { mode: ShellMode; tab: ShellTab }) {
  const groups = whichKeyGroupsShell(mode, tab);
  return (
    <Box flexDirection="column" backgroundColor={theme.surfaceRaised} paddingX={2} width={100}>
      <Text bold color={theme.textPrimary}> KEYS · {mode} · {tab} </Text>
      <Box>
        {groups.map(g => (
          <Box key={g.group} flexDirection="column" marginRight={3}>
            <Text bold color={theme.textPrimary}>{g.group}</Text>
            {g.entries.map(e => (
              <Text key={e.key}><Text color={theme.seal}>{e.key}</Text><Text color={theme.textMuted}> {e.label}</Text></Text>
            ))}
          </Box>
        ))}
      </Box>
      <Text color={theme.textMuted}>press a key, or Esc to close · keys shown are exactly the active keymap</Text>
    </Box>
  );
}
