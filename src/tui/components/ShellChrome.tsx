import React from 'react';
import { Box, Text } from 'ink';
import { footerHintsShellShort, whichKeyGroupsShell, type ShellMode, type ShellTab } from '../keymap.js';
import { theme } from '../theme.js';
import { evidenceLook, type EvidenceState } from '../evidence.js';
import { evidenceGlyph } from '../ui/Evidence.js';

// C1b-2: connectivity marks — the circle set (○ ● ◉ ◌ ✓) is reserved for evidence
export const LIVE = { on: '■', off: '□' } as const;

// TUI REDESIGN (spec §02/§07) — the footer and which-key overlay render FROM
// the keymap object; nothing here is a hand-typed hint string.
// FIX 4 (director): hints fit BY CONSTRUCTION — measure the fixed segments,
// then keep whole tokens from the left until the budget is spent (dropping
// from the right). A token is never split; the line never wraps.
/**
 * The mode badge is structure, not evidence: inverse video of the terminal's own colors, so it reads in
 * any palette and paints no color of its own (B2, row 28); a human-present mode (INSERT/CHAT) is also
 * bold. (Row 26 drew NORMAL white on grey-2 and the other modes black on white, in law hex.)
 */
export function modeBadgeStyle(mode: ShellMode): { inverse: true; bold: boolean } {
  return { inverse: true, bold: mode !== 'NORMAL' };
}

export function ShellFooter({ mode, tab, chainOk, chainEvidence, chainCount, busLive, width = 120, model }: {
  mode: ShellMode; tab: ShellTab; chainOk: boolean; chainEvidence?: EvidenceState | 'refused'; chainCount: number; busLive: boolean; width?: number; model?: string;
}) {
  const badge = modeBadgeStyle(mode);
  const badgeSeg = ` ${mode} `;
  // SPEC §02: the CHAT footer names the sovereign model from policy
  const tabSeg = mode === 'CHAT' ? ` sovereign · ${model ?? '—'}   ` : ` ${tab}   `;
  // C1b-2: the chain segment carries the chain's ONE evidence state (● built ·
  // ✓ checked by a receipted verify · ◌ stale once receipts follow it · × broken)
  const ev: EvidenceState | 'refused' = chainEvidence ?? (chainOk ? 'constructed' : 'refused');
  const chainSeg = `  chain ${evidenceGlyph(ev)} ${chainCount}`;
  const busSeg = `  bus ${busLive ? LIVE.on : LIVE.off}`;
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
      <Text inverse={badge.inverse} bold={badge.bold}>{badgeSeg}</Text>
      <Text color={theme.textMuted}>{tabSeg}{kept.join('  ')}</Text>
      <Text color={ev === 'refused' ? theme.refuse : evidenceLook(ev).color} bold={ev === 'checked'}>{chainSeg}</Text>
      <Text color={theme.textMuted}>{busSeg}</Text>
    </Box>
  );
}

// ui-cockpit-k7m3 C5: the overlay is as wide as the shell (it was a fixed 100
// columns, wider than an 80-column terminal) and the caller positions it over
// the body so it never adds rows below the fold.
// Fourth order, step 2 (semantic color plus text labels): every status mark named in words, in its own
// color, so no mark or color carries a meaning alone (found in Terminal on the Mac, row 52).
const MARKS: Array<{ glyph: string; word: string; color: string }> = [
  ...(['declared', 'constructed', 'checked', 'inferred', 'stale'] as const).map((s) => ({
    glyph: evidenceLook(s).glyph,
    word: { declared: 'declared', constructed: 'built', checked: 'checked', inferred: 'made by a model', stale: 'stale' }[s],
    color: evidenceLook(s).color,
  })),
  { glyph: '×', word: 'refused', color: theme.refuse },
  { glyph: LIVE.on, word: 'on', color: theme.textPrimary },
  { glyph: LIVE.off, word: 'off', color: theme.textPrimary },
];

export function WhichKeyOverlay({ mode, tab, width = 100 }: { mode: ShellMode; tab: ShellTab; width?: number }) {
  const groups = whichKeyGroupsShell(mode, tab);
  return (
    <Box flexDirection="column" backgroundColor={theme.surfaceRaised} paddingX={2} width={width}>
      <Text bold color={theme.textPrimary}> KEYS · {mode} · {tab} </Text>
      <Box>
        {groups.map(g => (
          <Box key={g.group} flexDirection="column" marginRight={3}>
            <Text bold color={theme.textPrimary}>{g.group}</Text>
            {g.entries.map(e => (
              <Text key={e.key}><Text bold color={theme.textPrimary}>{e.key}</Text><Text color={theme.textMuted}> {e.label}</Text></Text>
            ))}
          </Box>
        ))}
      </Box>
      <Text color={theme.textMuted}>press a key, or click a tab or a [key] · Esc closes · keys shown are exactly the active keymap</Text>
      <Text color={theme.textMuted}>to select text while the mouse is on: hold Shift and drag (Option in iTerm2)</Text>
      <Text>
        <Text color={theme.textMuted}>marks</Text>
        {MARKS.map((m) => <Text key={m.word}>  <Text color={m.color}>{m.glyph}</Text><Text color={theme.textMuted}> {m.word}</Text></Text>)}
      </Text>
      {tab === 'LIBRARY' ? <Text color={theme.textMuted}>models  caps: T tools · V vision · R reasoning  fit: ◉ a forecast, not a measurement</Text> : null}
    </Box>
  );
}
