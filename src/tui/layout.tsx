// v1.0.4 cyber-command shell (design refs tui3/tui6/tui7): 1-row header
// with status pills, 5-col icon rail, main viewport, 1-row footer with
// keymap pills. Everything inside a strict full-screen bounding box; all
// lines clamp. Budget: header 1 + footer 1 + main rows−2.
import React, { useEffect, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { theme } from './theme.js';
import { VERSION } from '../version.js';
import { checkDocker, checkComfyCli } from '../utils/doctor.js';
import { layoutBudget, footerKeysLine, VIEWS } from './utils/ergonomics.js';

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
  /** v1.0.5-keyboard-arch: focus stack top, always visible in the footer */
  focusTop?: string;
  children: React.ReactNode;
}

export function Layout({
  view,
  model,
  totalCost,
  activeRunId,
  focusTop,
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

  const modelShort = (model ?? 'local/none').split('/').pop() ?? model;
  const sess = activeRunId ? activeRunId.slice(0, 12) : 'live';

  return (
    // key={view}: full remount per view — ink's TTY diff can drop the header
    // row when switching between tall panels (p10 PTY evidence).
    // v2 exemption: the shell owns its tabs; remounting here would reset the
    // shell machine on every legacy digit (the digit-shadowing damage, C3).
    <Box key={process.env.TIMMY_SHELL === 'v1' ? view : undefined} flexDirection="column" width={W} height={H}>
      {/* ══ HEADER — 1 row: brand · center view tabs · right pills ══
          v2 shell prints its own header cluster from the bus (spec §03), and
          the legacy pills paint DOCKER: DOWN in red — a contract violation
          (off is dim, red is refusals only). Hidden behind the cutover flag. */}
      {process.env.TIMMY_SHELL === 'v1' && (
      <Box paddingX={1} flexShrink={0} height={1}>
        <Text bold color={theme.accent} wrap="truncate">[TIMMY TRUST OS v{VERSION}]</Text>
        <Box flexGrow={1} justifyContent="center">
          {VIEWS.map((vd, i) => (
            <Text key={vd.key} bold={i === view} color={i === view ? theme.accent : theme.textMuted} wrap="truncate">
              {W >= 170
                ? (i === view ? `[ ${vd.key} ${vd.label} ]` : ` ${vd.key} ${vd.label} `)
                : W >= 140
                  ? (i === view ? `[${vd.key} ${vd.label.slice(0, 3)}]` : ` ${vd.key} ${vd.label.slice(0, 3)} `)
                  : (i === view ? `[${vd.key}]` : ` ${vd.key} `)}
            </Text>
          ))}
        </Box>
        <Text color={env.docker ? theme.accent : theme.danger} wrap="truncate">● DOCKER: {env.docker ? 'ACTIVE' : 'DOWN'} </Text>
        {W >= 90 && <Text color={env.comfy ? theme.accent : theme.danger} wrap="truncate">● COMFY: {env.comfy ? 'READY' : 'OFF'} </Text>}
        {W >= 90 && <Text color={theme.accent} wrap="truncate">COST: ${totalCost.toFixed(2)}</Text>}
      </Box>
      )}

      {/* ══ BODY — full-width dual-card viewport (rail removed v1.0.5) ══ */}
      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={1} flexDirection="row" paddingX={1}>
          <ViewportContext.Provider value={{ w: Math.max(40, W - 2), h: budget.main }}>
            {children}
          </ViewportContext.Provider>
        </Box>
      </Box>

      {/* ══ FOOTER — 1 row, single pre-padded Text (no flex contention) ══
          v2 shell prints its own ShellFooter (spec §02: ONE footer is the
          source of truth), so the legacy line hides behind the cutover flag. */}
      {process.env.TIMMY_SHELL === 'v1' && (
      <Box paddingX={1} flexShrink={0}>
        <Text wrap="truncate">
          <Text color={theme.textMuted}>{W >= 100 ? `~/timmy · ${sess}` : ''}</Text>
          <Text bold color={focusTop === 'nav' ? theme.accent : theme.accent}>{` MODE:${(focusTop ?? 'nav').toUpperCase()}`}</Text>
          <Text color={theme.textSecondary}>{' '.repeat(Math.max(1, W - 2 - ((W >= 100 ? 10 + sess.length : 0) + 9 + footerKeysLine(Math.max(40, W - 24)).length)))}</Text>
          <Text color={theme.textSecondary}>{footerKeysLine(Math.max(40, W - 24))}</Text>
        </Text>
      </Box>
      )}
    </Box>
  );
}
