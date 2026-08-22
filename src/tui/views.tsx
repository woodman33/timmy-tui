// v1.0.1 ergonomic overhaul — the four top-level views. The cramped 8-mode
// monolith is gone: [1] Command & Chat, [2] Mission DAG & Capsules,
// [3] Telemetry & LogRain, [4] Escrow & Receipts. Legacy panels are reused
// as content; the shell owns navigation, budget and chrome.
import React from 'react';
import { Box } from 'ink';
import type { Agent } from '../agent/core.js';
import { CommandView } from './components/CommandView.js';
import { LogRelay } from './components/LogRelay.js';
import { theme } from './theme.js';
import { SlatePanel } from './panels/SlatePanel.js';
import { GensPanel } from './panels/GensPanel.js';
import { LogsPanel } from './panels/LogsPanel.js';
import { LogRain } from './panels/LogRain.js';
import { ActionCards } from './components/ActionCards.js';
import { EscrowReceiptsView } from './components/EscrowReceiptsView.js';
import { PaneFocusContext } from './components/PanelFrame.js';
import { ViewportContext } from './layout.js';

export interface ViewStageProps {
  view: number;
  paneFocus: number;
  agent: Agent;
  setInspector: (d: unknown) => void;
  setModalInput: (b: boolean) => void;
  inputLocked: boolean;
}

const noopZone = (_z: number): void => undefined;

export function ViewStage({ view, paneFocus, agent, setInspector, setModalInput, inputLocked }: ViewStageProps) {
  const { w: width, h: height } = React.useContext(ViewportContext);
  const pane = (i: number): boolean => paneFocus === i;

  if (view === 0) {
    // v1.0.4 cyber-command: 60% round conversation card + 40% LIVE relay
    return (
      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={3} flexDirection="column" paddingRight={1}>
          <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="round"
            borderColor={pane(0) ? theme.cardFocus : theme.borderMuted}
            paddingX={1}
          >
            <CommandView agent={agent} />
          </Box>
        </Box>
        <Box flexGrow={2} flexDirection="column" paddingLeft={1}>
          <LogRelay height={height} />
        </Box>
      </Box>
    );
  }

  if (view === 1) {
    // task/capsule cards live here now (evicted from View [1])
    return (
      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={3} flexDirection="column" paddingRight={1}>
          <PaneFocusContext.Provider value={pane(0)}>
            <SlatePanel agent={agent} setInspector={setInspector} zone={0} setZone={noopZone} setModalInput={setModalInput} inputLocked={inputLocked} />
          </PaneFocusContext.Provider>
        </Box>
        <Box flexGrow={2} flexDirection="column" paddingLeft={1}>
          <ActionCards width={Math.max(30, Math.floor(width * 0.4))} />
          <PaneFocusContext.Provider value={pane(1)}>
            <GensPanel agent={agent} setInspector={setInspector} zone={0} setZone={noopZone} setModalInput={setModalInput} inputLocked={inputLocked} />
          </PaneFocusContext.Provider>
        </Box>
      </Box>
    );
  }

  if (view === 2) {
    const rainW = Math.max(28, Math.min(52, Math.floor(width * 0.36)));
    return (
      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={1} flexDirection="column" paddingRight={1}>
          <PaneFocusContext.Provider value={pane(0)}>
            <LogsPanel agent={agent} setInspector={setInspector} zone={0} setZone={noopZone} />
          </PaneFocusContext.Provider>
        </Box>
        <Box width={rainW} flexDirection="column" flexShrink={0}>
          <PaneFocusContext.Provider value={pane(1)}>
            <LogRain height={Math.max(8, height - 4)} focused={pane(1)} />
          </PaneFocusContext.Provider>
        </Box>
      </Box>
    );
  }

  return <EscrowReceiptsView paneFocus={paneFocus} width={width} height={height} />;
}
