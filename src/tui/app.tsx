// v1.0.1 ergonomic overhaul — app shell. Four top-level views ([1-4],
// Tab walks pane focus), no left nav, no ambient rain in chat. The shell
// owns navigation + budget; ViewStage owns content; Layout owns chrome.
import React, { useState, useEffect } from 'react';
import { render, useApp, useInput, Box, Text } from 'ink';
import { createAgent } from '../agent/core.js';
import type { AgentConfig } from '../types/index.js';
import { Layout } from './layout.js';
import { ViewStage } from './views.js';
import { VIEWS, VIEW_PANES, PALETTE_MODELS } from './utils/ergonomics.js';
import { useTerminalCapabilities } from './hooks/useTerminalCapabilities.js';
import { useGraphicsPipeline } from './hooks/useGraphicsPipeline.js';
import { useAgent } from './hooks/useAgent.js';
import { useTelemetryBridge } from './hooks/useTelemetryBridge.js';
import { useCompanionSync } from './hooks/useCompanionSync.js';
import { useModeAgentConfig } from './hooks/useModeAgentConfig.js';

import { agentLogger, tuiLogger } from '../utils/logger.js';

import { Onboarding } from './Onboarding.js';
import { condenseSession } from '../utils/iceberg.js';
import { theme } from './theme.js';

interface AppProps {
  config: AgentConfig;
  graphicsType?: string;
}

function App({ config, graphicsType = 'auto' }: AppProps) {
  const { exit } = useApp();

  // v1.0.1 view grammar: 0 COMMAND · 1 MISSION · 2 TELEMETRY · 3 ESCROW
  const [view, setView] = useState(0);
  const [paneFocus, setPaneFocus] = useState(0);
  const [modalInput, setModalInput] = useState(false);
  const setInspectorSafe = React.useCallback((data: unknown) => {
    Promise.resolve().then(() => void data);
  }, []);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [showOnboard, setShowOnboard] = useState(() => !(config as any).onboarded);

  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const [activeReceiptUrl, setActiveReceiptUrl] = useState<string | undefined>(undefined);

  const agent = React.useMemo(() => createAgent(config), [config]);
  const agentState = useAgent(agent);
  const capsState = useTerminalCapabilities();

  const { telemetryStatus, queuedTelemetryCount } = useTelemetryBridge({
    agent,
    mode: 'brief',
    model: agentState.model,
    totalCost: agentState.totalCost,
    config,
    activeRunId,
    activeReceiptUrl,
    operator: 'William Meldman'
  });

  useCompanionSync({ agent, messages: agentState.messages, activeRunId, activeReceiptUrl });
  useModeAgentConfig({ agent, mode: 'brief', config });

  useEffect(() => {
    const handleRunCreated = (data: any) => {
      agentLogger.info(`run.created: ${JSON.stringify(data)}`);
      if (data && data.runId) {
        setActiveRunId(data.runId);
        setActiveReceiptUrl(`https://timmy-ai-proxy.wmeldman33.workers.dev/runs/${data.runId}/receipt`);
      }
    };
    const handleTelemetryRun = (data: any) => {
      agentLogger.info(`telemetry:run: ${JSON.stringify(data)}`);
      if (data && data.runId) {
        setActiveRunId(data.runId);
        if (data.receiptUrl) setActiveReceiptUrl(data.receiptUrl);
      }
    };
    agent.on('run.created' as any, handleRunCreated);
    agent.on('telemetry:run' as any, handleTelemetryRun);
    return () => {
      agent.off('run.created' as any, handleRunCreated);
      agent.off('telemetry:run' as any, handleTelemetryRun);
    };
  }, [agent]);

  useEffect(() => {
    const startupRunId = `run_${Math.random().toString(36).substring(2, 9)}`;
    agent.emit('run.created' as any, {
      runId: startupRunId,
      receiptUrl: `https://timmy-ai-proxy.wmeldman33.workers.dev/runs/${startupRunId}/receipt`,
      source: 'timmy-tui-startup',
      timestamp: Date.now()
    });
  }, [agent]);

  const animState: 'idle' | 'thinking' | 'streaming' | 'tool_call' | 'error' | 'success' = agentState.isThinking
    ? (agentState.currentTools.length > 0 ? 'tool_call' : 'thinking')
    : agentState.isStreaming
      ? 'streaming'
      : agentState.error
        ? 'error'
        : 'idle';

  const { pipeline } = useGraphicsPipeline(capsState.capabilities, animState, graphicsType);

  const safeExit = () => {
    try { condenseSession(); } catch { /* best-effort */ }
    try { if (pipeline) pipeline.cleanup(); } catch { /* guard */ }
    exit();
  };

  const gotoView = (v: number) => {
    setView(v);
    setPaneFocus(0);
  };

  const paletteItems = [
    ...VIEWS.map((vd, i) => ({ label: `${vd.key} · ${vd.label}`, action: () => gotoView(i) })),
    // v1.0.2: model switching + health live strictly here, never in a sidebar
    ...PALETTE_MODELS.map(m => ({ label: `model · ${m.label}`, action: () => agentState.switchModel(m.id) })),
    { label: 'q · Exit Application', action: safeExit }
  ];

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      tuiLogger.info('Ctrl+C captured. Clean exit.');
      safeExit();
      return;
    }
    if (key.ctrl && input === 'k') {
      setCommandPaletteOpen(prev => !prev);
      setPaletteIdx(0);
      return;
    }
    if (key.ctrl && input === 'l') {
      gotoView(2);
      return;
    }

    if (commandPaletteOpen) {
      if (key.escape) { setCommandPaletteOpen(false); return; }
      if (key.upArrow) { setPaletteIdx(prev => Math.max(0, prev - 1)); return; }
      if (key.downArrow) { setPaletteIdx(prev => Math.min(paletteItems.length - 1, prev + 1)); return; }
      if (key.return) { paletteItems[paletteIdx].action(); setCommandPaletteOpen(false); return; }
      return;
    }

    if (helpOpen) {
      if (key.escape || input === '?') setHelpOpen(false);
      return;
    }

    const autocompleteActive = Boolean((agent as any).autocompleteActive);
    if (modalInput || autocompleteActive) return;

    // [1-4] views · Tab focus · [L] telemetry · [q] quit · [?] help
    if (input >= '1' && input <= '4') { gotoView(Number(input) - 1); return; }
    if (input === 'l') { gotoView(2); return; }
    if (input === 'q') { safeExit(); return; }
    if (input === '?') { setHelpOpen(true); return; }
    if (key.tab) {
      const panes = VIEW_PANES[view] ?? 1;
      setPaneFocus(prev => key.shift ? (prev - 1 + panes) % panes : (prev + 1) % panes);
      return;
    }
  });

  if (showOnboard) {
    return <Onboarding agent={agent} onDone={() => setShowOnboard(false)} />;
  }

  return (
    <Layout
      view={view}
      paneFocus={paneFocus}
      model={agentState.model}
      totalCost={agentState.totalCost}
      animState={animState}
      activeRunId={activeRunId}
      telemetryStatus={telemetryStatus}
      queuedTelemetryCount={queuedTelemetryCount}
    >
      <Box flexGrow={1} flexShrink={1}>
        <ViewStage
          view={view}
          paneFocus={paneFocus}
          agent={agent}
          setInspector={setInspectorSafe}
          setModalInput={setModalInput}
          inputLocked={commandPaletteOpen}
        />

        {/* v1.0.4: SOLID full-card overlay — opaque #16161e field, never
            a transparent float over text */}
        {commandPaletteOpen && (
          <Box
            position="absolute"
            top={2}
            left={20}
            borderStyle="double"
            borderColor={theme.brand}
            backgroundColor={theme.bgDeep}
            paddingX={2}
            flexDirection="column"
            width={52}
            height={paletteItems.length + 4}
          >
            <Text bold color={theme.brand}>🏛️ TIMMY COMMAND PALETTE (^K)</Text>
            <Text color={theme.borderDefault}>──────────────────────────────────────────────</Text>
            {paletteItems.map((item, idx) => {
              const isSelected = idx === paletteIdx;
              return (
                <Box key={item.label} backgroundColor={isSelected ? theme.surfaceOverlay : undefined}>
                  <Text color={isSelected ? theme.focus : theme.textPrimary} bold={isSelected}>
                    {String(idx + 1).padStart(2, ' ')}. {item.label}
                  </Text>
                </Box>
              );
            })}
            <Text color={theme.borderDefault}>──────────────────────────────────────────────</Text>
            <Text color={theme.textTertiary}>Arrows scroll · Enter choose · Esc dismiss</Text>
          </Box>
        )}

        {helpOpen && (
          <Box
            position="absolute"
            top={2}
            left={20}
            borderStyle="double"
            borderColor={theme.success}
            backgroundColor={theme.bgDeep}
            paddingX={2}
            flexDirection="column"
            width={52}
          >
            <Text bold color={theme.success}>❓ VIEW GRAMMAR — {VIEWS[view]?.label}</Text>
            <Text color={theme.textSecondary}>────────────────────────────────────────────────</Text>
            <Text color={theme.textPrimary}>[1-4]     switch top-level views</Text>
            <Text color={theme.textPrimary}>[Tab]     cycle pane focus (⇧Tab reverses)</Text>
            <Text color={theme.textPrimary}>[L]       jump to TELEMETRY</Text>
            <Text color={theme.textPrimary}>[^K]      models + command palette</Text>
            <Text color={theme.textPrimary}>[?]       this overlay · [q] quit · ^C quit</Text>
            <Text color={theme.textSecondary}>────────────────────────────────────────────────</Text>
            <Text color={theme.textSecondary} dimColor>Press ? or ESC to close</Text>
          </Box>
        )}
      </Box>
    </Layout>
  );
}

export function startTUI(config: AgentConfig, mode?: string, graphicsType = 'auto') {
  void mode; // legacy --mode flag accepted; the 4-view shell owns navigation
  // v1.0.4: alternate screen buffer + cleared scrollback; the UI lives in a
  // strict full-screen bounding box and restores the terminal on exit.
  process.stdout.write('\x1b[?1049h\x1b[3J\x1b[H');
  process.on('exit', () => {
    try { process.stdout.write('\x1b[?1049l'); } catch { /* terminal gone */ }
  });
  render(<App config={config} graphicsType={graphicsType} />, {
    exitOnCtrlC: false,
    debug: false,
  });
}
