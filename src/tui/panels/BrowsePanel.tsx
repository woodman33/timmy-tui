import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useFocus, panelMayAct } from '../hooks/useKeyDispatcher.js';
import { execFileSync } from 'child_process';
import type { Agent } from '../../agent/core.js';
import { PaneFocusContext } from '../components/PanelFrame.js';
import { KeyHintBar } from '../components/KeyHintBar.js';
import { Card, BudgetList, EmptyState } from '../ui/index.js';
import { stripAnsi } from '../utils/text.js';
import { theme } from '../theme.js';

interface BrowsePanelProps {
  agent: Agent;
  setInspector?: (s: string | null) => void;
  zone?: number;
  setZone?: (z: number) => void;
  setModalInput?: (b: boolean) => void;
  inputLocked?: boolean;
}

/**
 * BROWSE — dual-pane web workspace. Left: your carbonyl (Chromium-in-terminal)
 * browser lanes. Right: the LIVE pane output. [t] sends keystrokes/commands
 * straight into the browser pane; heavier automation (playwright / puppeteer /
 * chrome-devtools CLIs) gets delegated through LANES as deterministic profiles.
 */
export function BrowsePanel({ agent, zone = 0, setZone, setModalInput, inputLocked }: BrowsePanelProps) {
  const [idx, setIdx] = useState(0);
  const [capture, setCapture] = useState<string[]>([]);
  const [spawning, setSpawning] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [typing, setTyping] = useState(false);
  const [cmdDraft, setCmdDraft] = useState('');
  const [noCarb, setNoCarb] = useState(false);
  const [carbHint, setCarbHint] = useState(false);
  const focused = React.useContext(PaneFocusContext);

  useEffect(() => {
    try { execFileSync('sh', ['-c', 'command -v carbonyl'], { stdio: 'ignore' }); setNoCarb(false); }
    catch { setNoCarb(true); }
  }, []);

  const lanes = agent.tmuxSessions.filter(s => s.name.startsWith('Browser:'));
  const sel = lanes[Math.min(idx, Math.max(0, lanes.length - 1))];
  const selIdx = Math.min(idx, Math.max(0, lanes.length - 1));

  useEffect(() => {
    const load = () => {
      const current = agent.tmuxSessions.filter(s => s.name.startsWith('Browser:'));
      const s = current[Math.min(idx, Math.max(0, current.length - 1))];
      if (!s) { setCapture([]); return; }
      try {
        const out = execFileSync('tmux', ['capture-pane', '-pt', `ortui-${s.id}`], { encoding: 'utf8', stdio: 'pipe' });
        setCapture(out.split('\n').map(stripAnsi).slice(-20));
      } catch { setCapture(['[pane not running]']); }
    };
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [idx, agent.tmuxSessions.length]);

  const __focus = useFocus();
  useInput((char, key) => {
    if (!panelMayAct(__focus, 'input:browse')) return;
    if (zone < 0) return; // nav owns the keyboard
    if (spawning) {
      if (key.escape) { setSpawning(false); setUrlDraft(''); __focus.release('input:browse'); return; }
      if (key.return) {
        agent.addBrowserPane(urlDraft.trim() || 'https://openrouter.ai');
        setSpawning(false);
        setUrlDraft('');
        __focus.release('input:browse');
        return;
      }
      if (key.backspace || key.delete) { setUrlDraft(d => d.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta) setUrlDraft(d => d + char);
      return;
    }
    if (typing) {
      if (key.escape) { setTyping(false); setCmdDraft(''); __focus.release('input:browse'); return; }
      if (key.return) {
        if (sel && cmdDraft.trim()) agent.sendTmuxCommand(sel.id, cmdDraft.trim(), true);
        setTyping(false);
        setCmdDraft('');
        __focus.release('input:browse');
        return;
      }
      if (key.backspace || key.delete) { setCmdDraft(d => d.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta) setCmdDraft(d => d + char);
      return;
    }
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(Math.max(0, lanes.length - 1), i + 1)); return; }
    // ONE GRAMMAR: ←→ move between panes (nav ↔ list ↔ live pane)
    if (key.leftArrow) { setZone?.(Math.max(-1, zone - 1)); return; }
    if (key.rightArrow) { setZone?.(Math.min(1, zone + 1)); return; }
    const c = char.toLowerCase();
    if (c === 'n') {
      if (noCarb) { setCarbHint(true); return; }
      setCarbHint(false);
      setSpawning(true);
      __focus.claim('input:browse');
      return;
    }
    if (c === 't' && sel) { setTyping(true); __focus.claim('input:browse'); return; }
    if (c === 'k' && sel) { agent.removeTmuxSession(sel.id); setIdx(i => Math.max(0, i - 1)); return; }
  }, { isActive: !inputLocked });

  return (
    <Card
      title="Browse — dual-pane web workspace"
      focused={focused}
      purpose="chromium in the terminal via carbonyl · heavier automation delegates through LANES"
      pill={{ kind: lanes.length ? 'accent' : 'muted', label: `${lanes.length} browser pane${lanes.length === 1 ? '' : 's'}` }}
      flexGrow={1}
    >
      {carbHint && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.textMuted}>carbonyl (chromium-in-terminal) not found on PATH</Text>
          <Text color={theme.textSecondary}>install it and [n] works. Meanwhile: SLATE [v] and any addBrowserPane call</Text>
          <Text color={theme.textSecondary}>open browser panes through the agent, and LANES covers CLI agents.</Text>
        </Box>
      )}
      {lanes.length === 0 ? (
        <EmptyState line="no browser panes yet" action="[n] spawns carbonyl on any URL" />
      ) : (
        <Box flexDirection="row" flexGrow={1}>
          {/* the in-pane browser frame list */}
          <Box flexDirection="column" width="34%" paddingRight={1}>
            <BudgetList
              items={lanes}
              max={7}
              offset={Math.max(0, selIdx - 6)}
              render={(l, i) => (
                <Text key={l.id} color={i === selIdx ? theme.accent : theme.textPrimary} bold={i === selIdx} wrap="truncate">
                  {i === selIdx ? '▸ ' : '  '}{l.name.replace('Browser: ', '')}
                </Text>
              )}
            />
          </Box>
          <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
            <Text bold color={theme.accent} wrap="truncate">live · {sel?.name}</Text>
            {capture.slice(-12).map((line, i) => (
              <Text key={i} color={theme.textSecondary} wrap="truncate">{stripAnsi(line) || ' '}</Text>
            ))}
            {spawning && (
              <Box marginTop={1}>
                <Text color={theme.accent}>url: {urlDraft || 'https://'}█</Text>
              </Box>
            )}
            {typing && (
              <Box marginTop={1}>
                <Text color={theme.accent}>→ pane: {cmdDraft}█</Text>
              </Box>
            )}
          </Box>
        </Box>
      )}
      <KeyHintBar hints={[
        { key: 'n', label: 'new pane (url)' },
        { key: 't', label: 'type into pane' },
        { key: 'k', label: 'kill pane' }
      ]} />
    </Card>
  );
}
