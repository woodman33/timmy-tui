// v1.0.1 ergonomic overhaul — app shell. Four top-level views ([1-4],
// Tab walks pane focus), no left nav, no ambient rain in chat. The shell
// owns navigation + budget; ViewStage owns content; Layout owns chrome.
import React, { useState, useEffect, useRef } from 'react';
import { render, useApp, Box, Text } from 'ink';
import { FocusProvider, useFocus, useKeyDispatcher } from './hooks/useKeyDispatcher.js';
import { Card } from './ui/Card.js';
import { ReceiptDetail, ReceiptOpenContext } from './components/ReceiptDetail.js';
import { readChain } from '../utils/receipts.js';
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

export function App(props: AppProps) {
  // v1.0.5-keyboard-arch: the focus stack lives above everything
  return <FocusProvider><Shell {...props} /></FocusProvider>;
}

function Shell({ config, graphicsType = 'auto' }: AppProps) {
  const { exit } = useApp();

  // v1.0.1 view grammar: 0 COMMAND · 1 MISSION · 2 TELEMETRY · 3 ESCROW
  const [view, setView] = useState(0);
  const [paneFocus, setPaneFocus] = useState(0);
  const setInspectorSafe = React.useCallback((data: unknown) => {
    Promise.resolve().then(() => void data);
  }, []);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [detailHash, setDetailHash] = useState<string | null>(null);
  const openReceiptRef = useRef<(h: string) => void>(() => {});
  const [showOnboard, setShowOnboard] = useState(() => !(config as any).onboarded);

  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const [activeReceiptUrl, setActiveReceiptUrl] = useState<string | undefined>(undefined);

  const agent = React.useMemo(() => createAgent(config), [config]);
  const agentState = useAgent(agent);
  // BOOT (opentui-u4e9): the first frame is the header with the chain head —
  // capability/graphics/telemetry/companion/mode-config probes start AFTER it.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    const t = setImmediate(() => setBooted(true));
    return () => clearImmediate(t);
  }, []);
  const capsState = useTerminalCapabilities(booted);

  const { telemetryStatus, queuedTelemetryCount } = useTelemetryBridge({
    agent,
    mode: 'brief',
    model: agentState.model,
    totalCost: agentState.totalCost,
    config,
    activeRunId,
    activeReceiptUrl,
    operator: 'William Meldman',
    enabled: booted
  });

  useCompanionSync({ agent, messages: agentState.messages, activeRunId, activeReceiptUrl, enabled: booted });
  useModeAgentConfig({ agent, mode: 'brief', config, enabled: booted });

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

  const { pipeline } = useGraphicsPipeline(capsState.capabilities, animState, graphicsType, booted);

  const safeExit = () => {
    try { condenseSession(); } catch { /* best-effort */ }
    try { if (pipeline) pipeline.cleanup(); } catch { /* guard */ }
    exit();
    // v1.0.5-keyboard-arch: a lingering handle (companion spawn, heartbeat
    // socket) must never block a clean quit; the exit hook restores the
    // alt-screen before this fires.
    setTimeout(() => process.exit(0), 250);
  };

  const gotoView = (v: number) => {
    setView(v);
    setPaneFocus(0);
  };

  const paletteItems = [
    // p10: "Go to view/feature" — nothing depends on memorizing keys
    ...VIEWS.map((vd, i) => ({ label: `go · [${vd.key}] ${vd.label} — ${vd.sub}`, action: () => gotoView(i) })),
    { label: 'feature · J-BANG dispatch rail', action: () => gotoView(4) },
    { label: 'feature · harness lanes', action: () => gotoView(4) },
    { label: 'feature · escrow ledger + refunds', action: () => gotoView(3) },
    { label: 'feature · receipt chain verify', action: () => gotoView(3) },
    { label: 'feature · live log relay + passport', action: () => gotoView(2) },
    { label: 'feature · mission DAG + capsules', action: () => gotoView(1) },
    { label: 'feature · clips + EDL replay', action: () => gotoView(6) },
    { label: 'feature · model explorer', action: () => { gotoView(7); setPaneFocus(2); } },
    { label: 'feature · setup / onboarding prefs', action: () => { gotoView(7); setPaneFocus(1); } },
    { label: 'feature · code review + dashboard', action: () => gotoView(8) },
    // v1.0.2: model switching + health live strictly here, never in a sidebar
    ...PALETTE_MODELS.map(m => ({ label: `model · ${m.label}`, action: () => agentState.switchModel(m.id) })),
    // C2 (ui.audit): palette receipt results open the detail modal on Enter
    ...(() => { try { return readChain('runs').slice(-5).reverse().map(r => { const h = String(r.hash ?? ''); return { label: `receipt · ${h.slice(7, 15)} · ${String(r.subject ?? '')}`, action: () => openReceiptRef.current(h.slice(7, 15)) }; }); } catch { return []; } })(),
    { label: 'q · Exit Application', action: safeExit }
  ];

  // v1.0.5-keyboard-arch: ONE root dispatcher; the focus stack replaces the
  // modalInput boolean. Palette/help visibility mirrors the stack so Esc-pop
  // at the dispatcher closes them structurally.
  const focus = useFocus();
  useEffect(() => {
    if (!focus.stack.includes('modal:palette')) setCommandPaletteOpen(false);
  }, [focus.stack]);
  useEffect(() => {
    if (!focus.stack.includes('modal:help')) setHelpOpen(false);
  }, [focus.stack]);
  useEffect(() => {
    if (!focus.stack.includes('modal:receipt')) setDetailHash(null);
  }, [focus.stack]);
  const openReceipt = (h: string) => { focus.claim('modal:receipt'); setDetailHash(h); };
  openReceiptRef.current = openReceipt;

  useKeyDispatcher({
    view,
    gotoView,
    cyclePane: rev => {
      const panes = VIEW_PANES[view] ?? 1;
      setPaneFocus(prev => rev ? (prev - 1 + panes) % panes : (prev + 1) % panes);
    },
    openPalette: () => { focus.claim('modal:palette'); setCommandPaletteOpen(true); setPaletteIdx(0); },
    paletteKey: (input, key) => {
      if (key.upArrow) { setPaletteIdx(p => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setPaletteIdx(p => Math.min(paletteItems.length - 1, p + 1)); return; }
      if (key.return) { paletteItems[paletteIdx].action(); focus.release('modal:palette'); return; }
    },
    toggleHelp: () => { focus.claim('modal:help'); setHelpOpen(true); },
    quit: () => { tuiLogger.info('quit captured. Clean exit.'); safeExit(); },
    jumpTelemetry: () => gotoView(2),
    enterCommandInput: () => focus.claim('input:command')
  });

  if (showOnboard) {
    return <Onboarding agent={agent} onDone={() => setShowOnboard(false)} />;
  }

  return (
  <ReceiptOpenContext.Provider value={openReceipt}>
    <Layout
      view={view}
      paneFocus={paneFocus}
      model={agentState.model}
      totalCost={agentState.totalCost}
      animState={animState}
      activeRunId={activeRunId}
      telemetryStatus={telemetryStatus}
      queuedTelemetryCount={queuedTelemetryCount}
      focusTop={focus.top}
    >
      <Box flexGrow={1} flexShrink={1}>
        <ViewStage
          view={view}
          paneFocus={paneFocus}
          agent={agent}
          setInspector={setInspectorSafe}
        />

        {/* SOLID full-card overlay — opaque surfaceRaised field, never
            a transparent float over text */}
        {commandPaletteOpen && (
          <Box position="absolute" top={2} left={20} backgroundColor={theme.surfaceRaised} paddingX={1} flexDirection="column" width={56}>
            <Card title="COMMAND PALETTE" focused purpose="^K anything · arrows scroll · enter choose · esc dismiss">
              {paletteItems.map((item, idx) => {
                const isSelected = idx === paletteIdx;
                return (
                  <Text key={item.label} color={isSelected ? theme.accent : theme.textPrimary} bold={isSelected}>
                    {isSelected ? '▸' : ' '} {String(idx + 1).padStart(2, ' ')}. {item.label}
                  </Text>
                );
              })}
            </Card>
          </Box>
        )}

        {helpOpen && process.env.TIMMY_SHELL === 'v1' && (
          <Box position="absolute" top={2} left={20} backgroundColor={theme.surfaceRaised} paddingX={1} flexDirection="column" width={56}>
            <Card title={`VIEW GRAMMAR — ${VIEWS[view]?.label ?? ''}`} focused purpose="press ? or esc to close">
              <Text bold color={theme.accent}>WHAT IS TIMMY?</Text>
              <Text color={theme.textSecondary}>Terminal-first Agent Trust OS — a flight recorder for AI agent runs.</Text>
              <Text color={theme.textSecondary}>What is a receipt? Every action seals a SHA-256 / ed25519 receipt; chains verify from [4] ESCROW.</Text>
              <Box height={1} />
              <Text color={theme.textPrimary}>[1-9]     switch views</Text>
              <Text color={theme.textPrimary}>[Tab]     cycle pane focus (⇧Tab reverses)</Text>
              <Text color={theme.textPrimary}>[L]       jump to TELEMETRY</Text>
              <Text color={theme.textPrimary}>[^K]      models + command palette</Text>
              <Text color={theme.textPrimary}>[?]       this overlay · [q] quit · ^C quit</Text>
            </Card>
          </Box>
        )}

        {detailHash && <ReceiptDetail hash={detailHash} />}
      </Box>
    </Layout>
  </ReceiptOpenContext.Provider>
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
