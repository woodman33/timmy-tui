import React from 'react';
import { Box, Text, renderToString } from 'ink';
import { GlowBorder } from '../src/tui/components/GlowBorder.js';
import { StatusPill } from '../src/tui/components/Motion.js';
import { MODES } from '../src/tui/router.js';
import { stripTerminalCodes, truncateVisible, visibleWidth } from '../src/tui/utils/text.js';
import { theme } from '../src/tui/theme.js';

const SIZES: Array<[number, number]> = [
  [80, 24],
  [100, 30],
  [120, 36],
  [140, 40],
  [160, 48],
  [164, 54],
  [171, 55],
];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function validateRenderedBox(output: string, maxWidth: number, label: string): void {
  const clean = stripTerminalCodes(output);
  const lines = clean.split('\n').filter(line => line.length > 0);

  assert(lines.some(line => (line.includes('╭') && line.includes('╮')) || (line.includes('┌') && line.includes('┐'))), `${label}: missing closed top border`);
  assert(lines.some(line => (line.includes('╰') && line.includes('╯')) || (line.includes('└') && line.includes('┘'))), `${label}: missing closed bottom border`);
  for (const line of lines) {
    assert(visibleWidth(line) <= maxWidth, `${label}: line exceeds ${maxWidth} columns: ${line}`);
  }
}

assert(
  MODES.join('>') === 'brief>hermes>workspace>logs',
  `unexpected launch mode order: ${MODES.join('>')}`
);


for (const [columns, rows] of SIZES) {
  const panelWidth = Math.max(20, columns - 4);
  const visibleColumnCount = panelWidth >= 92 ? 4 : 2;
  const columnGap = 1;
  const columnWidth = Math.max(18, Math.floor((panelWidth - columnGap * (visibleColumnCount - 1)) / visibleColumnCount));
  const boardHeight = Math.max(8, rows - 15);

  assert(panelWidth <= columns, `${columns}x${rows}: panel width overflow`);
  assert(columnWidth * visibleColumnCount + columnGap * (visibleColumnCount - 1) <= panelWidth, `${columns}x${rows}: board columns overflow`);
  assert(boardHeight >= 8, `${columns}x${rows}: board collapsed`);

  const boardOutput = renderToString(
    <Box width={panelWidth} flexDirection="row">
      {Array.from({ length: visibleColumnCount }).map((_, idx) => (
        <Box key={idx} marginRight={idx < visibleColumnCount - 1 ? columnGap : 0}>
          <GlowBorder width={columnWidth} height={boardHeight} color={theme.textSecondary} label={`LANE ${idx + 1}`}>
            <Box paddingX={1}>
              <Text>{truncateVisible('Receipt card with a deliberately long evidence summary', Math.max(1, columnWidth - 4))}</Text>
            </Box>
          </GlowBorder>
        </Box>
      ))}
    </Box>,
    { columns }
  );

  const chatOutput = renderToString(
    <Box flexDirection="column" width={panelWidth}>
      <GlowBorder width={panelWidth} height={5} color={theme.structure} label="CHAT FIRST SURFACE">
        <Box paddingX={1}>
          <Text>{truncateVisible('Ask TIMMY to route work, explain a change, or prepare a governed run.', Math.max(1, panelWidth - 4))}</Text>
        </Box>
      </GlowBorder>
    </Box>,
    { columns }
  );

  const proofOutput = renderToString(
    <GlowBorder
      width={panelWidth}
      height={4}
      color={theme.textPrimary}
      label="RECEIPT PROOF"
    >
      <Box paddingX={1}>
        <Text>{truncateVisible('Ctrl+S snapshots run state without changing provider runtime behavior', Math.max(1, panelWidth - 4))}</Text>
      </Box>
    </GlowBorder>,
    { columns }
  );

  const rmuxOutput = renderToString(
    <Box width={panelWidth} justifyContent="space-between">
      {['Run', 'RMUX', 'Approval', 'Proof'].map((label) => (
        <StatusPill key={label} label={label} value={label === 'RMUX' ? 'optional' : 'ready'} width={Math.max(16, Math.floor(panelWidth * 0.21))} />
      ))}
    </Box>,
    { columns }
  );

  validateRenderedBox(boardOutput, panelWidth, `${columns}x${rows} board`);
  validateRenderedBox(chatOutput, panelWidth, `${columns}x${rows} chat`);
  validateRenderedBox(proofOutput, panelWidth, `${columns}x${rows} proof`);
  validateRenderedBox(rmuxOutput, panelWidth, `${columns}x${rows} rmux status`);
}

console.log('OK TIMMY TUI smoke: animated launch screens, four-panel board, RMUX status, and width budgets passed for 80x24, 100x30, 120x36, 140x40, 160x48, 164x54, 171x55.');
