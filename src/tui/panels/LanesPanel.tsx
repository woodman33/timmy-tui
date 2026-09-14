import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useFocus, panelMayAct } from '../hooks/useKeyDispatcher.js';
import { execFileSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Agent } from '../../agent/core.js';
import { PaneFocusContext } from '../components/PanelFrame.js';
import { KeyHintBar } from '../components/KeyHintBar.js';
import { Card, BudgetList, EmptyState } from '../ui/index.js';
import { LANE_RUNNERS, DEFAULT_LANE_BINDINGS } from '../../agent/lanes.js';
import { stripAnsi } from '../utils/text.js';
import { osc52Copy } from '../../utils/notify.js';
import { appendReceipt } from '../../utils/receipts.js';
import { appendEvent } from '../../utils/eventbus.js';
import { RUN_START, parseRunEnd } from '../../utils/openhands.js';
import { theme } from '../theme.js';

interface LanesPanelProps {
  agent: Agent;
  setInspector?: (s: string | null) => void;
  zone?: number;
  setZone?: (z: number) => void;
  setModalInput?: (b: boolean) => void;
  inputLocked?: boolean;
}

/**
 * LANES — the multi-agent workspace, for real. Every pane is a live
 * multiplexer session: you see its actual output, delegate real tasks,
 * approve risky commands, spawn and kill. No simulated states anywhere.
 */
export function LanesPanel({ agent, zone = 0, setZone, setModalInput, inputLocked }: LanesPanelProps) {
  const [idx, setIdx] = useState(0);
  const [capture, setCapture] = useState<string[]>([]);
  const [alive, setAlive] = useState<Record<string, boolean>>({});
  const [installed, setInstalled] = useState<Record<string, boolean | null>>({});
  const [tasking, setTasking] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [coach, setCoach] = useState(() => !existsSync(join(process.cwd(), '.timmy', '.lanes-coach')));
  const sealedRuns = useRef<Record<string, number>>({});
  const focused = React.useContext(PaneFocusContext);

  // guiding UX: a concrete first task per runner, so nobody stares at six
  // green dots wondering what to do
  const suggested = (laneId: string): string => {
    const runner = DEFAULT_LANE_BINDINGS[laneId];
    const map: Record<string, string> = {
      opencode: 'fix the most recent failing test',
      hermes: "summarize today's sealed receipts",
      pi: 'list the 3 largest files and why they matter',
      jcode: 'review the last commit in one paragraph',
      minds: 'research: receipt-backed AI compliance (EU AI Act Art. 12)',
      openhands: 'autonomously fix the most recent failing test (headless)',
      systems: 'print the fleet status'
    };
    return map[runner] || 'echo hello from TIMMY';
  };

  const lanes = agent.tmuxSessions;
  const blocked = (agent as any).lastBlockedCommands as Map<string, string> | undefined;

  useEffect(() => {
    const load = () => {
      const nextAlive: Record<string, boolean> = {};
      const nextInst: Record<string, boolean | null> = {};
      for (const l of lanes) {
        try { execFileSync('tmux', ['has-session', '-t', `ortui-${l.id}`], { stdio: 'ignore' }); nextAlive[l.id] = true; }
        catch { nextAlive[l.id] = false; }
        const runner = LANE_RUNNERS[DEFAULT_LANE_BINDINGS[l.id]];
        if (!runner) nextInst[l.id] = null;
        else {
          try { execFileSync('sh', ['-c', `command -v ${runner.cmd}`], { stdio: 'ignore' }); nextInst[l.id] = true; }
          catch { nextInst[l.id] = false; }
        }
      }
      // OpenHands headless runs seal a receipt when the END marker lands.
      // Headless auto-approves INSIDE its loop — the jailed workspace is the
      // boundary; the receipt + approval gate stay ours.
      for (const l of lanes) {
        if (DEFAULT_LANE_BINDINGS[l.id] !== 'openhands' || !nextAlive[l.id]) continue;
        try {
          const raw = execFileSync('tmux', ['capture-pane', '-pt', `ortui-${l.id}`], { encoding: 'utf8', stdio: 'pipe' }).split('\n').map(stripAnsi);
          const starts = raw.filter(x => x.includes(RUN_START)).length;
          const end = parseRunEnd(raw);
          const sealed = sealedRuns.current[l.id] ?? 0;
          if (end && starts > sealed) {
            sealedRuns.current[l.id] = starts;
            appendReceipt('runs', {
              kind: 'run',
              subject: `openhands headless · lane ${l.id} · exit ${end.code}`,
              policy: 'human-gated',
              spans: [{ name: 'openhands headless', kind: 'execute_tool' }],
              decisions: [{ decision: 'allow', effect: 'shell.exec', tier: 'T2', reason: 'jailed workspace (TIMMY_WORKSPACE)' }],
              cost_usd: 0
            });
            appendEvent(end.code === 0 ? 'run.completed' : 'run.failed', { lane: l.id, exit: end.code });
            setNote(`openhands run sealed (exit ${end.code}) — receipt in runs stream`);
          }
        } catch { /* capture best-effort */ }
      }
      setAlive(nextAlive);
      setInstalled(nextInst);
      const sel = lanes[Math.min(idx, Math.max(0, lanes.length - 1))];
      if (sel && nextAlive[sel.id]) {
        try {
          const out = execFileSync('tmux', ['capture-pane', '-pt', `ortui-${sel.id}`], { encoding: 'utf8', stdio: 'pipe' });
          setCapture(
            out.split('\n').map(stripAnsi)
              // hide launcher plumbing — show the agent's output, not its bootstrap script
              .filter(l => !/printf '|else quote>|export PATH=|TIMMY_EXIT_CODE|sleep 3; if command|williams-macbook/i.test(l))
              .filter((l, i, a) => !(i > a.length - 8 && l.trim() === ''))
              .slice(-20)
          );
        } catch { setCapture(['[capture failed]']); }
      } else {
        setCapture([]);
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [idx, lanes]);

  const selIdx = Math.min(idx, Math.max(0, lanes.length - 1));
  const sel = lanes[selIdx];
  const selBlocked = sel ? blocked?.get(sel.id) : undefined;
  const aliveCount = lanes.filter(l => alive[l.id]).length;
  const blockedCount = lanes.filter(l => blocked?.has(l.id)).length;

  const __focus = useFocus();
  useInput((char, key) => {
    if (!panelMayAct(__focus, 'input:lanes')) return;
    if (zone < 0) return; // nav owns the keyboard
    if (tasking) {
      if (key.escape) { setTasking(false); setDraft(''); __focus.release('input:lanes'); return; }
      if (key.return) {
        if (sel && draft.trim()) agent.sendTmuxCommand(sel.id, draft.trim());
        setTasking(false);
        setDraft('');
        __focus.release('input:lanes');
        return;
      }
      if (key.backspace || key.delete) { setDraft(d => d.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta) setDraft(d => d + char);
      return;
    }
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(Math.max(0, lanes.length - 1), i + 1)); return; }
    // ONE GRAMMAR: ←→ move between panes (nav ↔ roster ↔ live output)
    if (key.leftArrow) { setZone?.(Math.max(-1, zone - 1)); return; }
    if (key.rightArrow) { setZone?.(Math.min(1, zone + 1)); return; }
    const c = char.toLowerCase();
    if (c === 'n' && sel) { agent.addTmuxSession(sel.name, sel.model); return; }
    if (c === 'k' && sel) { agent.removeTmuxSession(sel.id); setIdx(i => Math.max(0, i - 1)); return; }
    if (c === 'g' && sel && selBlocked) { agent.sendTmuxCommand(sel.id, selBlocked, true); return; }
    if (c === 'o' && sel) { setNote(`attach in your own terminal: tmux attach -t ortui-${sel.id}  (full control, same session)`); return; }
    if (c === 'y' && sel) { osc52Copy(`tmux attach -t ortui-${sel.id}`); setNote('attach one-liner copied (OSC-52/pbcopy)'); return; }
    if (c === 'v') {
      // tmux tabs over every lane: one watch session with linked windows
      try {
        execFileSync('tmux', ['new-session', '-d', '-s', 'timmy-watch'], { stdio: 'ignore' });
        for (const l of lanes) {
          try { execFileSync('tmux', ['link-window', '-d', '-s', `ortui-${l.id}:0`, '-t', 'timmy-watch:'], { stdio: 'ignore' }); } catch { /* already linked */ }
        }
        setNote('timmy-watch built — tmux attach -t timmy-watch · Ctrl-b n/p = next/prev lane tab');
      } catch { setNote('tmux unavailable — lanes run, but the watch session needs tmux'); }
      return;
    }
    if (char === 'G') {
      // tiled grid: every lane live in one window (nested attaches, tiled)
      try {
        execFileSync('tmux', ['kill-session', '-t', 'timmy-grid'], { stdio: 'ignore' });
      } catch { /* not running */ }
      try {
        const [first, ...restLanes] = lanes;
        if (!first) { setNote('no lanes alive to grid'); return; }
        execFileSync('tmux', ['new-session', '-d', '-s', 'timmy-grid', '-x', '220', '-y', '60', `tmux attach -t ortui-${first.id}`], { stdio: 'ignore' });
        for (const l of restLanes) {
          try { execFileSync('tmux', ['split-window', '-t', 'timmy-grid:0', `tmux attach -t ortui-${l.id}`], { stdio: 'ignore' }); } catch { /* pane limit */ }
        }
        execFileSync('tmux', ['select-layout', '-t', 'timmy-grid:0', 'tiled'], { stdio: 'ignore' });
        setNote('timmy-grid built — tmux attach -t timmy-grid · the whole crew, one window');
      } catch { setNote('tmux unavailable — grid needs tmux'); }
      return;
    }
    if (c === 'x' && coach) {
      setCoach(false);
      try { mkdirSync(join(process.cwd(), '.timmy'), { recursive: true }); writeFileSync(join(process.cwd(), '.timmy', '.lanes-coach'), new Date().toISOString(), 'utf8'); } catch { /* best effort */ }
      return;
    }
    // t = type-into, prefilled with the suggested task (delegate = type suggested)
    if (c === 't' || key.return) {
      if (sel) setDraft(suggested(sel.id));
      setTasking(true);
      __focus.claim('input:lanes');
      return;
    }
  }, { isActive: !inputLocked });

  return (
    <Card
      title="Lanes — live agent panes"
      focused={focused}
      purpose="real multiplexer sessions — you're watching their actual terminals, risky commands stop for approval"
      pill={{
        kind: blockedCount ? 'accent' : aliveCount ? 'accent' : 'muted',
        label: `${aliveCount}/${lanes.length} alive${blockedCount ? ` · ${blockedCount} waiting on you` : ''}`
      }}
      flexGrow={1}
    >
      {note && <Text color={theme.accent} wrap="truncate">{note}</Text>}
      <Box flexDirection="row" flexGrow={1}>
        {/* lane roster */}
        <Box flexDirection="column" width="38%" paddingRight={1}>
          <BudgetList
            items={lanes}
            max={7}
            offset={Math.max(0, selIdx - 6)}
            render={(l, i) => {
              const isSel = i === selIdx;
              const runner = LANE_RUNNERS[DEFAULT_LANE_BINDINGS[l.id]];
              const isBlocked = blocked?.has(l.id);
              const isAlive = alive[l.id];
              const color = isBlocked ? theme.warn : isAlive ? theme.accent : theme.textSecondary;
              return (
                <Box flexDirection="column">
                  <Text color={isSel ? theme.accent : color} bold={isSel} wrap="truncate">
                    {isSel ? '▸ ' : '  '}{isAlive ? '●' : ' '} {l.name}{isBlocked ? ' · waiting on you' : ''}
                  </Text>
                  <Text color={theme.textSecondary} wrap="truncate">
                      {'   '}{runner?.blurb || runner?.label || 'shell'}{installed[l.id] === false ? ` · missing ${runner?.cmd} — install: ${runner?.install || 'add to PATH'}` : ''}{isAlive ? '' : ' · not running'}
                  </Text>
                  {isSel && (
                    <Text color={theme.textSecondary} wrap="truncate">
                      {'   '}try: {suggested(l.id)} · [t] delegates it
                    </Text>
                  )}
                </Box>
              );
            }}
          />
        </Box>
        {/* live pane output */}
        <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
          {sel ? (
            <>
              <Text bold color={theme.accent} wrap="truncate">live · ortui-{sel.id} · {sel.name}</Text>
              {/402|Insufficient credits|Internal Server Error/.test(capture.join('\n')) && (
                <Text color={theme.warn}>lane hit a provider error (credits/500) — raw output below · [g]/resend from chat</Text>
              )}
              {selBlocked && (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold color={theme.warn}>BLOCKED — waiting on you: {selBlocked}</Text>
                  <Text color={theme.textSecondary}>[g] approve & run · anything else leaves it parked</Text>
                </Box>
              )}
              {alive[sel.id] ? (
                capture.slice(-12).map((line, i) => (
                  <Text key={i} color={theme.textSecondary} wrap="truncate">{stripAnsi(line) || ' '}</Text>
                ))
              ) : (
                <EmptyState line="pane not running" action="[n] spawns it — you'll watch it boot here, live" />
              )}
              {tasking && (
                <Box marginTop={1}>
                  <Text color={theme.accent}>task → {sel.name}: {draft}█</Text>
                </Box>
              )}
            </>
          ) : (
            <EmptyState line="no lanes yet — the chat home screen boots the default five" />
          )}
        </Box>
      </Box>
      {coach && !tasking && (
        <Text color={theme.textMuted} wrap="truncate">
          first time here? this is your crew — six real agents, not decorations · [t] delegate · [g] approve · [x] dismiss
        </Text>
      )}
      <KeyHintBar hints={[
        { key: '↑↓', label: 'lane' },
        { key: 't/↵', label: 'type task' },
        { key: 'g', label: 'approve' },
        { key: 'n', label: 'spawn' },
        { key: 'k', label: 'kill' },
        { key: 'o', label: 'attach' },
        { key: 'v', label: 'tmux tabs' },
        { key: 'G', label: 'grid' }
      ]} />
    </Card>
  );
}
