import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useFocus, panelMayAct } from '../hooks/useKeyDispatcher.js';
import { theme } from '../theme.js';
import { Card, SectionRule, Pill, type PillKind } from '../ui/index.js';
import { execSync } from 'child_process';
import { openExternal } from '../../utils/external-open.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import http from 'http';
import { truncateVisible } from '../utils/text.js';

interface CodeReviewPanelProps {
  agent: any;
  setInspector: (data: any) => void;
  focusArea?: 'nav' | 'stage';
}

function checkUrlHealth(url: string, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const req = http.request(
        {
          method: 'HEAD',
          hostname: parsedUrl.hostname,
          port: parsedUrl.port ? parseInt(parsedUrl.port, 10) : 80,
          path: parsedUrl.pathname,
          timeout: timeoutMs,
        },
        (res) => {
          resolve(res.statusCode ? res.statusCode >= 200 && res.statusCode < 400 : false);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

export function CodeReviewPanel({ agent, setInspector, focusArea = 'stage' }: CodeReviewPanelProps) {
  const { columns: width } = useWindowSize();

  // Binary detection & health states
  const [carbonylInstalled, setCarbonylInstalled] = useState(false);
  const [tmuxInstalled, setTmuxInstalled] = useState(false);
  const [browserRunning, setBrowserRunning] = useState<boolean | null>(null);

  // Fallback states
  const [isTmuxExpanded, setIsTmuxExpanded] = useState(false);
  const [tmuxSessionExists, setTmuxSessionExists] = useState(false);
  const [tmuxLastOutput, setTmuxLastOutput] = useState<string>('No recent activity.');

  // Workspace Launcher active selection
  const [activeBtnIdx, setActiveBtnIdx] = useState(0);
  const [outputLog, setOutputLog] = useState<string>('Select an action to launch work surface.');
  const [inputCmd, setInputCmd] = useState('/workspace browser');

  const companionPort = (global as any).companionServer?.port || 3001;
  const companionUrl = `http://localhost:${companionPort}`;

  const buttons = [
    { label: 'Open In-Pane Browser', key: 'carbonyl', desc: 'SANDBOX: carbonyl Chromium lane (headless in terminal)' },
    { label: 'Open Browser Companion', key: 'browser', desc: 'Browser mirror surface' },
    { label: 'Open Local Files', key: 'files', desc: 'Workspace root explorer' },
    { label: 'View Logs', key: 'logs', desc: 'Bounded event logs' },
    { label: 'Show tmux Fallback', key: 'tmux', desc: 'Persistent run fallback' }
  ];

  const checkTmuxSession = () => {
    if (!tmuxInstalled) return;
    try {
      execSync('tmux has-session -t timmy-run 2>/dev/null');
      setTmuxSessionExists(true);
      const lastLine = execSync('tmux capture-pane -t timmy-run -p | tail -n 5 | grep -v "^$" | tail -n 1 2>/dev/null').toString().trim();
      if (lastLine) setTmuxLastOutput(lastLine);
    } catch {
      setTmuxSessionExists(false);
      setTmuxLastOutput('No active session.');
    }
  };

  // Detect binaries and setup
  useEffect(() => {
    try {
      execSync('command -v carbonyl', { stdio: 'ignore' });
      setCarbonylInstalled(true);
    } catch {
      setCarbonylInstalled(existsSync(join(homedir(), '.local', 'bin', 'carbonyl')));
    }

    try {
      execSync('command -v tmux', { stdio: 'ignore' });
      setTmuxInstalled(true);
    } catch {
      setTmuxInstalled(false);
    }

    checkUrlHealth(companionUrl).then(healthy => {
      setBrowserRunning(healthy);
    });
  }, []);

  useEffect(() => {
    checkTmuxSession();
  }, [tmuxInstalled]);

  // Dynamic next step state / inspector
  const updateInspectorData = () => {
    const btn = buttons[activeBtnIdx] || buttons[0];
    setInspector({
      title: 'TIMMY WORKSPACE OPERATOR',
      subtitle: 'VERIFIABLE PARALLEL LAUNCHER',
      type: 'Workspace Shell',
      status: 'READY',
      risk: 'LOW',
      scope: `workspace.launcher.${btn.key}`,
      details: [
        `• Selected Launcher: ${btn.label}`,
        `• carbonyl status: ${carbonylInstalled ? 'READY' : 'MISSING'}`,
        `• tmux status: ${tmuxInstalled ? 'READY' : 'MISSING'}`,
        `• Companion: ${browserRunning ? 'RUNNING' : 'NOT RUNNING'}`
      ]
    });
  };

  useEffect(() => {
    updateInspectorData();
  }, [activeBtnIdx, carbonylInstalled, tmuxInstalled, browserRunning]);

  // Main input cmd sync
  useEffect(() => {
    if (buttons[activeBtnIdx]) {
      const btn = buttons[activeBtnIdx];
      if (btn.key === 'files') {
        setInputCmd('/files');
      } else if (btn.key === 'logs') {
        setInputCmd('/logs');
      } else if (btn.key === 'tmux') {
        setInputCmd('/workspace tmux');
      } else if (btn.key === 'browser') {
        setInputCmd('/workspace browser');
      } else {
        setInputCmd(`/workspace launch ${btn.key}`);
      }
    }
  }, [activeBtnIdx]);

  const copyTmuxCommand = () => {
    try {
      execSync('echo "tmux attach -t timmy-run" | pbcopy');
      setOutputLog('✓ Attach command copied to clipboard: tmux attach -t timmy-run');
    } catch {
      setOutputLog('× Clipboard copy failed.');
    }
  };

  const killTmuxSession = () => {
    try {
      execSync('tmux kill-session -t timmy-run 2>/dev/null');
      checkTmuxSession();
      setOutputLog('✓ Active tmux fallback session killed successfully.');
    } catch (e: any) {
      setOutputLog(`× Kill command failed: ${e.message}`);
    }
  };

  // Key navigation engine
  const __focus = useFocus();
  useInput((char, key) => {
    if (!panelMayAct(__focus, 'input:codereview')) return;
    if (focusArea !== 'stage') return;

    if (key.leftArrow || key.upArrow) {
      setActiveBtnIdx(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow || key.downArrow || key.tab) {
      setActiveBtnIdx(prev => Math.min(4, prev + 1));
      return;
    }

    if (key.return) {
      const keyStr = buttons[activeBtnIdx]?.key;
      if (!keyStr) return;

      if (keyStr === 'carbonyl') {
        if (carbonylInstalled) {
          agent.emit('workspace:add-browser-pane', companionUrl);
          setOutputLog(`✓ Opening carbonyl in-pane browser lane at ${companionUrl}`);
        } else {
          setOutputLog('× carbonyl not found. Install: https://github.com/fathyb/carbonyl/releases');
        }
      } else if (keyStr === 'browser') {
        checkUrlHealth(companionUrl).then(healthy => {
          setBrowserRunning(healthy);
          if (healthy) {
            setOutputLog('✓ Port active. Launching companion interface in browser...');
            openExternal(companionUrl); // R4 lead: as an argument, never a shell string
          } else {
            setOutputLog('× Browser companion is not running. Start it first, then retry.');
          }
        });
      } else if (keyStr === 'files') {
        agent.emit('mode:change', 'files');
      } else if (keyStr === 'logs') {
        agent.emit('mode:change', 'logs');
      } else if (keyStr === 'tmux') {
        setIsTmuxExpanded(prev => !prev);
        if (!tmuxSessionExists && tmuxInstalled) {
          setOutputLog('✓ Initializing background tmux session...');
          try {
            execSync('tmux new-session -d -s timmy-run 2>/dev/null || true', { stdio: 'ignore' });
            checkTmuxSession();
            setOutputLog('✓ tmux fallback initialized. Details expanded below.');
          } catch (e: any) {
            setOutputLog(`× Failed to initialize tmux: ${e.message}`);
          }
        } else {
          setOutputLog('✓ Toggled tmux fallback details card view.');
        }
      }
    }

    if (char.toLowerCase() === 'c' && tmuxSessionExists) {
      copyTmuxCommand();
    } else if (char.toLowerCase() === 'k' && tmuxSessionExists) {
      killTmuxSession();
    }
  });

  // Responsive width calculation — REVIEW view: this panel owns the left
  // half of a two-pane row (layout.tsx breakpoints own the outer chrome).
  const terminalWidth = width || 80;
  const mainStageWidth = Math.max(30, Math.floor((terminalWidth - 4) / 2) - 2);

  const verdictFor = (key: string): { text: string; kind: PillKind } => {
    if (key === 'carbonyl') {
      return carbonylInstalled ? { text: 'READY', kind: 'accent' } : { text: 'MISSING', kind: 'danger' };
    }
    if (key === 'browser') {
      return browserRunning ? { text: 'RUNNING', kind: 'accent' } : { text: 'NOT RUNNING', kind: 'warn' };
    }
    if (key === 'tmux') {
      return tmuxInstalled ? { text: 'READY', kind: 'accent' } : { text: 'MISSING', kind: 'danger' };
    }
    return { text: 'READY', kind: 'accent' };
  };

  const renderRow = (idx: number) => {
    const isSelected = idx === activeBtnIdx;
    const btn = buttons[idx];
    const marker = isSelected ? '▸ ' : '  ';

    const verdict = verdictFor(btn.key);

    const rowWidth = mainStageWidth - 6;
    const col1Width = 3;
    const col3Width = 16;
    const showDesc = rowWidth > 55;
    const col2Width = showDesc ? 26 : Math.max(10, rowWidth - col1Width - col3Width - 2);
    const col4Width = showDesc ? Math.max(10, rowWidth - col1Width - col2Width - col3Width) : 0;

    const truncatedLabel = truncateVisible(marker + btn.label, col2Width - 1);
    const truncatedDesc = showDesc ? truncateVisible(btn.desc, col4Width - 1) : '';

    return (
      <Box key={btn.key} flexDirection="row" marginBottom={1} width={rowWidth}>
        <Box width={col1Width + col2Width} flexShrink={0}>
          <Text bold={isSelected} color={isSelected ? theme.accent : theme.textPrimary}>{truncatedLabel}</Text>
        </Box>
        <Box width={col3Width} flexShrink={0}>
          <Pill kind={verdict.kind} label={verdict.text} />
        </Box>
        {showDesc && (
          <Box width={col4Width} flexGrow={1} flexShrink={1}>
            <Text color={isSelected ? theme.textPrimary : theme.textSecondary}>{truncatedDesc}</Text>
          </Box>
        )}
      </Box>
    );
  };

  const activeBtn = buttons[activeBtnIdx] || buttons[0];
  let detailedExplain = '';
  let detailedAction = `[Enter] ${activeBtn.label}`;

  if (activeBtn.key === 'carbonyl') {
    detailedExplain = 'Spawns a carbonyl session (real Chromium renderer) as a tracked TIMMY lane inside your active multiplexer backend. Browsing happens headlessly in the terminal.';
  } else if (activeBtn.key === 'browser') {
    detailedExplain = 'Opens the Browser Companion. It mirrors chat, logs, workspace status, and receipts.';
  } else if (activeBtn.key === 'files') {
    detailedExplain = 'Opens the safe Workspace Root browser.';
  } else if (activeBtn.key === 'logs') {
    detailedExplain = 'Opens bounded local logs without corrupting the terminal.';
  } else if (activeBtn.key === 'tmux') {
    detailedExplain = 'tmux keeps a recoverable terminal session alive. It may not open a visual UI.';
  }

  // coverage verdict: how many surfaces are live right now
  const surfacesReady = [carbonylInstalled, tmuxInstalled, browserRunning === true].filter(Boolean).length;

  return (
    <Card
      title="TIMMY workspace"
      focused={focusArea === 'stage'}
      purpose="choose where work happens — carbonyl in-pane browser · companion mirror · tmux fallback"
      pill={surfacesReady === 3 ? { kind: 'accent', label: 'READY' } : { kind: 'warn', label: `${surfacesReady}/3 SURFACES` }}
      width={mainStageWidth}
      flexGrow={1}
    >
      {/* verdict meters — one per work surface */}
      <Box flexDirection="column">
        {buttons.map((_, idx) => renderRow(idx))}
      </Box>

      {/* Selected surface detail */}
      <SectionRule label="selected" />
      <Text bold color={theme.textPrimary}>{activeBtn.label}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.textSecondary}>what it does:</Text>
        <Text color={theme.textPrimary}>{detailedExplain}</Text>
      </Box>

      {activeBtn.key === 'carbonyl' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.textSecondary}>target URL:</Text>
          <Text color={theme.accent}>{companionUrl}</Text>
        </Box>
      )}

      {activeBtn.key === 'tmux' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.textSecondary}>attach command:</Text>
          <Text color={theme.accent} bold>tmux attach -t timmy-run</Text>
          {isTmuxExpanded && tmuxInstalled && (
            <Box flexDirection="column" marginY={1}>
              <Text color={theme.textPrimary}> · session name : <Text color={theme.textPrimary} bold>timmy-run</Text></Text>
              <Text color={theme.textPrimary}> · status       : {tmuxSessionExists ? <Text color={theme.accent} bold>READY</Text> : <Text color={theme.textSecondary}>STANDBY</Text>}</Text>
              <Text color={theme.textPrimary}> · last output  : <Text color={theme.textSecondary} italic>"{truncateVisible(tmuxLastOutput, Math.max(10, mainStageWidth - 30))}"</Text></Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1} flexDirection="row" justifyContent="flex-start">
        <Text bold color={theme.accent}>{detailedAction} </Text>
        {activeBtn.key === 'tmux' && tmuxSessionExists && (
          <Text color={theme.textSecondary}> | Press [C] to Copy Attach Command | Press [K] to Kill Session</Text>
        )}
      </Box>

      {/* Gated OpenHands status */}
      <Box marginTop={1} flexShrink={0}>
        <Text color={theme.textSecondary}>OpenHands Runner: not configured</Text>
      </Box>

      {/* Diagnostics */}
      <Box marginTop={1}>
        <SectionRule label="diagnostics" />
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.textSecondary}>{outputLog}</Text>
        <Text color={theme.textSecondary}>Press arrows / Tab to navigate. Enter selects surface.</Text>
      </Box>

      {/* Universal bottom input prompt */}
      <Box flexShrink={0}>
        <Text color={theme.textSecondary}>[ workspace ] </Text>
        <Text color={theme.accent}>▸ </Text>
        <Text color={theme.textPrimary}>{inputCmd}</Text>
        <Text color={theme.textSecondary}>█</Text>
      </Box>
    </Card>
  );
}
