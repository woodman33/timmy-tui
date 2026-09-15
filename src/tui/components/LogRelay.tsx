// v1.0.4 cyber-command — LIVE INVERTED LOG RELAY & PASSPORT. Newest-first
// stream with green timestamps, channel badges, and the embedded AgentPass
// seal badge. Solid card, no transparency, clamped lines.
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { Card } from '../ui/Card.js';
import { readEvents } from '../../utils/eventbus.js';
import { theme } from '../theme.js';

interface Ev { ts: string; kind: string; text: string }

const channel = (kind: string): { badge: string; color: string } => {
  if (kind.startsWith('escrow')) return { badge: '[ESCROW]', color: theme.accent };
  if (kind.startsWith('dispatch')) return { badge: '[WORKER]', color: theme.accent };
  if (kind.startsWith('gen') || kind.startsWith('comfy')) return { badge: '[R2]', color: theme.accent };
  if (kind.startsWith('receipt')) return { badge: '[SEAL]', color: theme.seal };
  return { badge: '[BUS]', color: theme.textMuted };
};

const stamp = (ts: string): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function LogRelay({ height }: { height: number }) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [seal, setSeal] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      try {
        const evs = readEvents(80) as { ts: string; kind: string; payload?: unknown }[];
        setEvents(evs.reverse().map(e => {
          const payload = e.payload && typeof e.payload === 'object' ? JSON.stringify(e.payload) : '';
          return { ts: e.ts, kind: String(e.kind), text: `${e.kind}${payload ? ' ' + payload.slice(1, 46) : ''}` };
        }));
        const sealed = (readEvents(200) as { kind: string; payload?: { hash?: string } }[])
          .reverse().find(e => e.kind === 'receipt.sealed' && e.payload?.hash);
        setSeal(sealed?.payload?.hash ?? null);
      } catch { /* bus unreadable */ }
    };
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  // budget: borders 2 + title 1 + seal 1 + gap 1 → events get the rest.
  // title/seal are flexShrink 0 so Yoga can never collapse them (v1.0.4 fix).
  const rows = Math.max(3, height - 7);
  return (
    <Card
      title="LIVE LOG RELAY"
      purpose="passport · tailing live"
      overflow={events.length > rows ? `…and ${events.length - rows} more · [3] full telemetry` : undefined}
      flexGrow={1}
    >
      <Box key="relay-seal" flexShrink={0}>
        <Text bold={Boolean(seal)} color={seal ? theme.seal : theme.textMuted} wrap="truncate">
          {seal ? `[SHA-256 SEALED] ${seal.slice(7, 23)}…` : '[SHA-256 SEALED] awaiting first seal…'}
        </Text>
      </Box>
      <Box key="relay-events" flexDirection="column" marginTop={1}>
        {events.slice(0, rows).map((e, i) => {
          const ch = channel(e.kind);
          return (
            <Text key={`${e.ts}-${i}`} wrap="truncate">
              <Text color={theme.accent}>{stamp(e.ts)}</Text>{' '}
              <Text color={ch.color}>{ch.badge}</Text>{' '}
              <Text color={theme.textSecondary}>{e.text}</Text>
            </Text>
          );
        })}
      </Box>
    </Card>
  );
}
