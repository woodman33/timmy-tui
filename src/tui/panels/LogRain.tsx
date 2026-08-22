import React, { memo, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { existsSync, openSync, closeSync, fstatSync, readSync } from 'fs';
import { join } from 'path';
import { theme } from '../theme.js';
import { humanizeLines, relTime, type HumanEvent } from '../../utils/humanlog.js';

interface LogRainProps {
  height: number;
  focused: boolean;
}

const REFRESH_MS = 2000;
const MAX_LINES = 200; // v1.0.2 mission spec: 200-line ring buffer
const TAIL_BYTES = 64 * 1024;

// Tail-only read: a CF event burst must never force a full-file parse on the
// TUI main thread (input lag / dropped keystrokes).
function readTail(p: string): { text: string; size: number } {
  const fd = openSync(p, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf-8'), size };
  } finally {
    closeSync(fd);
  }
}

/**
 * LogRain — the right-column live stream, in HUMAN words. Newest events land
 * at the TOP and rain downward (opposite of the chat, which rises). Raw
 * telemetry is counted, never printed; machine noise is filtered out.
 * Focus with Tab; ↓ digs into history, ↑ returns to the live edge.
 */
export const LogRain = memo(function LogRain({ height, focused }: LogRainProps) {
  const [rain, setRain] = useState<HumanEvent[]>([]);
  const [telCount, setTelCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const sigRef = useRef('');

  const load = () => {
    try {
      const parts: { text: string; size: number }[] = [];
      for (const f of ['timmy-tui.log', 'agent-events.log']) {
        const p = join('logs', f);
        if (existsSync(p)) parts.push(readTail(p));
      }
      const evFile = join('.timmy', 'runs', 'events.jsonl');
      if (existsSync(evFile)) parts.push(readTail(evFile));
      const sig = parts.map(p => p.size).join(',');
      if (sig === sigRef.current) return; // unchanged: no parse, no re-render
      sigRef.current = sig;
      const merged = parts.flatMap(p => p.text.split('\n')).filter(Boolean);
      const { events, telemetryCount } = humanizeLines(merged);
      setRain(events.reverse().slice(0, MAX_LINES));
      setTelCount(telemetryCount);
    } catch {
      // never crash the TUI on log IO
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  useInput((_char, key) => {
    if (key.downArrow) setOffset(o => Math.min(Math.max(0, rain.length - 1), o + 1));
    if (key.upArrow) setOffset(o => Math.max(0, o - 1));
  }, { isActive: focused });

  const visible = rain.slice(offset, offset + Math.max(3, height - 3));
  const live = offset === 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? theme.focus : theme.borderMuted} paddingX={1} flexShrink={0} height={height}>
      <Text bold color={focused ? theme.focus : theme.brandDim} wrap="truncate">{focused ? '◆' : '◇'} LIVE EVENT BUS</Text>
      <Box justifyContent="space-between">
        <Text bold color={focused ? theme.brand : theme.textSecondary}>⛆ WHAT'S HAPPENING ↓</Text>
        <Text color={live ? theme.success : theme.warning}>{live ? '▼ live' : `⏸ +${offset}`}</Text>
      </Box>
      {visible.length === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.textSecondary}>quiet…</Text>
          <Text color={theme.textSecondary}>events rain here</Text>
          <Text color={theme.textSecondary}>as they happen:</Text>
          <Text color={theme.textSecondary}>runs · models · gens</Text>
          <Text color={theme.textSecondary}>lanes · approvals</Text>
        </Box>
      ) : (
        visible.map((ev, i) => (
          <Text key={`${offset}-${i}`} color={i > 9 ? theme.textSecondary : ev.color} wrap="truncate">
            {relTime(ev.ts)} {ev.icon} {ev.text.length > 56 ? ev.text.slice(0, 53) + '…' : ev.text}
          </Text>
        ))
      )}
      {telCount > 0 && (
        <Text color={theme.textSecondary}>☁ telemetry ×{telCount} synced (hidden)</Text>
      )}
    </Box>
  );
});
