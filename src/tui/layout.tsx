// v1.0.4 cyber-command shell (design refs tui3/tui6/tui7): 1-row header
// with status pills, 5-col icon rail, main viewport, 1-row footer with
// keymap pills. Everything inside a strict full-screen bounding box; all
// lines clamp. Budget: header 1 + footer 1 + main rows−2.
import React, { useEffect, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { theme } from './theme.js';
import { VERSION } from '../version.js';
import { checkDocker, checkComfyCli } from '../utils/doctor.js';
import { layoutBudget, footerKeysLine } from './utils/ergonomics.js';

export const ViewportContext = React.createContext<{ w: number; h: number }>({ w: 80, h: 20 });

export interface LayoutProps {
  view: number;
  paneFocus: number;
  model: string;
  totalCost: number;
  animState: 'idle' | 'thinking' | 'streaming' | 'tool_call' | 'error' | 'success';
  telemetryStatus?: string;
  queuedTelemetryCount?: number;
  activeRunId?: string;
  children: React.ReactNode;
}

const RAIL_ICONS = ['>_', '⊞', '', '🛡', '⚙'];

export function Layout({
  view,
  model,
  totalCost,
  activeRunId,
  children
}: LayoutProps) {
  const raw = useWindowSize();
  const [dims, setDims] = useState({ w: raw.columns || 80, h: raw.rows || 24 });
  useEffect(() => {
    const t = setTimeout(() => setDims({ w: raw.columns || 80, h: raw.rows || 24 }), 120);
    return () => clearTimeout(t);
  }, [raw.columns, raw.rows]);
  const W = dims.w;
  const H = dims.h;
  const budget = layoutBudget(H);

  const [env, setEnv] = useState({ docker: false, comfy: false });
  useEffect(() => {
    const load = () => {
      try { setEnv({ docker: checkDocker().state === 'ok', comfy: checkComfyCli().state === 'ok' }); }
      catch { /* doctor unavailable */ }
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const modelShort = model.split('/').pop() ?? model;
  const sess = activeRunId ? activeRunId.slice(0, 12) : 'live';

  return (
    <Box flexDirection="column" width={W} height={H}>
      {/* ══ HEADER — 1 row, pills right-aligned ══ */}
      <Box paddingX={1} flexShrink={0}>
        <Text bold color={theme.neonCyan} wrap="truncate">[TIMMY TRUST OS v{VERSION}]</Text>
        {W >= 60 && <Text color={theme.textSecondary} wrap="truncate"> MODEL: {modelShort}</Text>}
        {W >= 72 && <Text color={theme.textTertiary} wrap="truncate"> SESSION: {sess}</Text>}
        <Box flexGrow={1} />
        <Text color={env.docker ? theme.emerald : theme.error} wrap="truncate">● DOCKER: {env.docker ? 'ACTIVE' : 'DOWN'} </Text>
        {W >= 90 && <Text color={env.comfy ? theme.emerald : theme.error} wrap="truncate">● COMFY: {env.comfy ? 'READY' : 'OFF'} </Text>}
        <Text color={theme.accent} wrap="truncate">COST: ${totalCost.toFixed(2)}</Text>
      </Box>

      {/* ══ BODY — 5-col icon rail + main viewport ══ */}
      <Box flexDirection="row" flexGrow={1}>
        <Box width={5} flexDirection="column" alignItems="center" paddingTop={1} flexShrink={0}>
          {RAIL_ICONS.map((ic, i) => (
            <Box key={ic} height={2} justifyContent="center">
              <Text bold={i === view} color={i === view ? theme.focus : i === 4 ? theme.brandDim : theme.textTertiary}>
                {ic}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexGrow={1} flexDirection="row" paddingX={1}>
          <ViewportContext.Provider value={{ w: Math.max(40, W - 7), h: budget.main }}>
            {children}
          </ViewportContext.Provider>
        </Box>
      </Box>

      {/* ══ FOOTER — 1 row: session left, keymap pills right ══ */}
      <Box paddingX={1} flexShrink={0}>
        <Text color={theme.textTertiary} wrap="truncate">~/timmy · {sess}</Text>
        <Box flexGrow={1} />
        <Text color={theme.textSecondary} wrap="truncate">{footerKeysLine(Math.max(40, W - 24))}</Text>
      </Box>
    </Box>
  );
}
