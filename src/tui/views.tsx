// v1.0.1 ergonomic overhaul — the four top-level views. The cramped 8-mode
// monolith is gone: [1] Command & Chat, [2] Mission DAG & Capsules,
// [3] Telemetry & LogRain, [4] Escrow & Receipts. Legacy panels are reused
// as content; the shell owns navigation, budget and chrome.
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { readdirSync } from 'fs';
import { join } from 'path';
import type { Agent } from '../agent/core.js';
import { Card } from './ui/Card.js';
import { HashChip } from './ui/HashChip.js';
import { EmptyState } from './ui/EmptyState.js';
import { listPlans } from '../utils/dispatch.js';
import { readChain } from '../utils/receipts.js';
import { readEvents } from '../utils/eventbus.js';
import { CommandView } from './components/CommandView.js';
import { Conversation } from './components/Conversation.js';
import { useOpenReceipt } from './components/ReceiptDetail.js';
import { LogRelay } from './components/LogRelay.js';
import { ShellV2 } from './components/ShellV2.js';
import { theme } from './theme.js';
import { SlatePanel } from './panels/SlatePanel.js';
import { LanesPanel } from './panels/LanesPanel.js';
import { DispatchRail } from './panels/DispatchRail.js';
import { BrowsePanel } from './panels/BrowsePanel.js';
import { FilesPanel } from './panels/FilesPanel.js';
import { ProjectsPanel } from './panels/ProjectsPanel.js';
import { ClipPanel } from './panels/ClipPanel.js';
import { OptionsPanel } from './panels/OptionsPanel.js';
import { SetupPanel } from './panels/SetupPanel.js';
import { ModelExplorerPanel } from './panels/ModelExplorerPanel.js';
import { CodeReviewPanel } from './panels/CodeReviewPanel.js';
import { DashboardPanel } from './panels/DashboardPanel.js';
import { ForgePanel } from '../forge/ForgePanel.js';
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
}

const noopZone = (_z: number): void => undefined;

// DESIGN.md §5.2 — HOME. Left: state line + three next-action cards +
// sovereign chat. Right: LATEST PROOF (the only bold green) + ACTIVITY in
// human sentences, 5 rows max.
function HomeView({ agent, focused, paneFocus }: { agent: Agent; focused: boolean; paneFocus: number }) {
  const [snap, setSnap] = React.useState<{
    plans: number; escrows: number; receipts: number;
    lastSeal: { hash: string; ts: string } | null; activity: string[];
  }>({ plans: 0, escrows: 0, receipts: 0, lastSeal: null, activity: [] });

  React.useEffect(() => {
    const load = () => {
      try {
        const plans = listPlans();
        let escrows = 0;
        try { escrows = readdirSync(join(process.cwd(), '.timmy', 'escrow')).filter(f => f.endsWith('.json')).length; } catch { /* none yet */ }
        const chain = readChain('runs');
        const evs = readEvents(30) as { ts: string; kind: string; payload?: Record<string, unknown> }[];
        const sealed = [...evs].reverse().find(e => e.kind === 'receipt.sealed');
        const human = (e: { kind: string; payload?: Record<string, unknown> }): string => {
          const p = e.payload ?? {};
          if (e.kind === 'receipt.sealed') return `receipt sealed · ${String(p.hash ?? '').slice(7, 15)}…`;
          if (e.kind === 'escrow.locked') return `escrow locked · ${String(p.escrow_id ?? '')}`;
          if (e.kind === 'escrow.armed') return `escrow armed · ${String(p.escrow_id ?? '')}`;
          if (e.kind === 'escrow.settled') return `escrow settled · refund ${String(p.refund_usd ?? '0')}`;
          if (e.kind === 'dispatch.created') return `plan stored · ${String(p.plan_id ?? '')}`;
          return e.kind;
        };
        setSnap({
          plans: plans.length, escrows, receipts: chain.length,
          lastSeal: sealed ? { hash: String(sealed.payload?.hash ?? ''), ts: sealed.ts } : null,
          activity: evs.slice(-5).map(human)
        });
      } catch { /* stay quiet */ }
    };
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, []);

  // C2 (ui.audit 3f6b191b6): ACTIVITY rail rows open receipt detail on Enter
  const openReceipt = useOpenReceipt();
  const [actIdx, setActIdx] = useState(0);
  useInput((input, key) => {
    if (paneFocus !== 1) return;
    if (key.upArrow) { setActIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setActIdx(i => Math.min(Math.max(snap.activity.length - 1, 0), i + 1)); return; }
    if (key.return) { const m = snap.activity[actIdx]?.match(/([0-9a-f]{8})/); if (m) openReceipt(m[1]); }
  }, { isActive: paneFocus === 1 });

  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box flexGrow={3} flexDirection="column" paddingRight={1}>
        <Card
          title="TIMMY"
          focused={focused}
          purpose="agents work · receipts prove it"
          pill={{ kind: 'accent', label: 'READY' }}
        >
          <Text color={theme.textSecondary} wrap="truncate">
            {snap.plans} plans · {snap.escrows} escrows · {snap.receipts} receipts
          </Text>
          <Box height={1} />
          <Text color={theme.textPrimary} wrap="truncate">▸ 1 resume mission        [Enter]</Text>
          <Text color={theme.textPrimary} wrap="truncate">▸ 2 spawn a lane           [5 then n]</Text>
          <Text color={theme.textPrimary} wrap="truncate">▸ 3 verify receipt chain   [4]</Text>
        </Card>
        <Box height={1} />
        <Card
          title="COMMAND POST"
          purpose="sovereign chat — Enter to speak · Esc back to nav"
          flexGrow={1}
        >
          {process.env.TIMMY_LEGACY_CHAT === '1'
            ? <CommandView agent={agent} />
            : <Conversation agent={agent} keys="dispatcher" />}
        </Card>
      </Box>
      <Box flexGrow={2} flexDirection="column" paddingLeft={1}>
        <Card title="LATEST PROOF" purpose="the only thing that glows green">
          {snap.lastSeal ? (
            <>
              <HashChip hash={snap.lastSeal.hash} sealed />
              <Text color={theme.textMuted}>{stamp(snap.lastSeal.ts)} · runs</Text>
            </>
          ) : (
            <EmptyState line="no receipts yet" action="run anything — it seals one" />
          )}
        </Card>
        <Box height={1} />
        <Card title="ACTIVITY" purpose="last five, in human sentences · [Enter] open · [Esc] back" overflow={snap.activity.length >= 5 ? '· tailing live' : undefined}>
          {snap.activity.length === 0 ? (
            <EmptyState line="quiet so far" action="[5] spawn a lane" />
          ) : (
            snap.activity.map((line, i) => (
              <Text key={i} color={i === actIdx ? theme.accent : theme.textSecondary} wrap="truncate">{i === actIdx ? '▸' : ' '}{line}</Text>
            ))
          )}
        </Card>
      </Box>
    </Box>
  );
}

const stamp = (ts: string): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function ViewStage({ view, paneFocus, agent, setInspector }: ViewStageProps) {
  const { w: width, h: height } = React.useContext(ViewportContext);
  const pane = (i: number): boolean => paneFocus === i;

  // TUI REDESIGN (tui-redesign-p6a3, CUTOVER): v2 shell is the DEFAULT; the
  // legacy nine-view shell stays behind TIMMY_SHELL=v1 for one release.
  if (process.env.TIMMY_SHELL !== 'v1') {
    return <ShellV2 width={width} agent={agent} />;
  }

  if (view === 0) {
    // DESIGN.md §5.2 — HOME: guided next-actions + sovereign chat left;
    // summarized proof + activity right (raw relay lives in View 3)
    return <HomeView agent={agent} focused={pane(0)} paneFocus={paneFocus} />;
  }

  if (view === 1) {
    // task/capsule cards live here now (evicted from View [1])
    return (
      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={3} flexDirection="column" paddingRight={1}>
          <PaneFocusContext.Provider value={pane(0)}>
            <SlatePanel agent={agent} setInspector={setInspector} zone={0} setZone={noopZone} />
          </PaneFocusContext.Provider>
        </Box>
        <Box flexGrow={2} flexDirection="column" paddingLeft={1}>
          <ActionCards width={Math.max(30, Math.floor(width * 0.4))} />
          <PaneFocusContext.Provider value={pane(1)}>
            <GensPanel agent={agent} setInspector={setInspector} zone={0} setZone={noopZone} />
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

  if (view === 3) {
    return <EscrowReceiptsView paneFocus={paneFocus} width={width} height={height} />;
  }

  // p10: surface every working panel (views 5-9)
  if (view === 4) {
    return (
      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={3} flexDirection="column" paddingRight={1}>
          <PaneFocusContext.Provider value={pane(0)}>
            <LanesPanel agent={agent} setInspector={setInspector} zone={0} setZone={noopZone} />
          </PaneFocusContext.Provider>
        </Box>
        <Box flexGrow={2} flexDirection="column" paddingLeft={1}>
          <PaneFocusContext.Provider value={pane(1)}>
            <DispatchRail width={Math.max(30, Math.floor(width * 0.4))} />
          </PaneFocusContext.Provider>
        </Box>
      </Box>
    );
  }

  if (view === 5) {
    return (
      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={1} flexDirection="column" paddingRight={1}>
          <PaneFocusContext.Provider value={pane(0)}>
            <BrowsePanel agent={agent} setInspector={setInspector} zone={0} setZone={noopZone} />
          </PaneFocusContext.Provider>
        </Box>
        <Box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <PaneFocusContext.Provider value={pane(1)}>
            <FilesPanel agent={agent} setInspector={setInspector} />
          </PaneFocusContext.Provider>
        </Box>
      </Box>
    );
  }

  if (view === 6) {
    return (
      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={1} flexDirection="column" paddingRight={1}>
          <PaneFocusContext.Provider value={pane(0)}>
            <ProjectsPanel agent={agent} setInspector={setInspector} zone={0} setZone={noopZone} />
          </PaneFocusContext.Provider>
        </Box>
        <Box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <PaneFocusContext.Provider value={pane(1)}>
            <ClipPanel agent={agent} setInspector={setInspector} zone={0} setZone={noopZone} />
          </PaneFocusContext.Provider>
        </Box>
      </Box>
    );
  }

  if (view === 7) {
    // SYSTEM: Tab selects among the three system panels
    return (
      <Box flexDirection="row" flexGrow={1}>
        {paneFocus === 0 && (
          <PaneFocusContext.Provider value={true}>
            <OptionsPanel agent={agent} setInspector={setInspector} />
          </PaneFocusContext.Provider>
        )}
        {paneFocus === 1 && (
          <PaneFocusContext.Provider value={true}>
            <SetupPanel agent={agent} />
          </PaneFocusContext.Provider>
        )}
        {paneFocus >= 2 && (
          <PaneFocusContext.Provider value={true}>
            <ModelExplorerPanel agent={agent} setInspector={setInspector} />
          </PaneFocusContext.Provider>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box flexGrow={1} flexDirection="column" paddingRight={1}>
        <PaneFocusContext.Provider value={pane(0)}>
          <CodeReviewPanel agent={agent} setInspector={setInspector} />
        </PaneFocusContext.Provider>
      </Box>
      <Box flexGrow={1} flexDirection="column" paddingLeft={1}>
        <PaneFocusContext.Provider value={pane(1)}>
          {/* p13 FORGE glass (D1): flag-gated swap; demo path unchanged */}
          {process.env.TIMMY_FORGE === '1'
            ? <ForgePanel width={Math.max(30, Math.floor(width / 2))} />
            : <DashboardPanel agent={agent} setInspector={setInspector} />}
        </PaneFocusContext.Provider>
      </Box>
    </Box>
  );
}
