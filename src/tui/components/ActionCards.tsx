import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { listPlans } from '../../utils/dispatch.js';
import { theme } from '../theme.js';
import { truncateVisible } from '../utils/text.js';

// v1.0.5: status pills per the dual-card spec
const LIFE_GLYPH: Record<string, { g: string; c: string }> = {
  needs_approval: { g: '[QUEUED]', c: theme.warning },
  armed: { g: '[QUEUED]', c: theme.warning },
  running: { g: '[RUNNING]', c: theme.focus },
  judging: { g: '[RUNNING]', c: theme.focus },
  passed: { g: '[DONE]', c: theme.success },
  failed: { g: '[FAIL]', c: theme.error }
};

// v1.0.1: concise J-BANG action cards — the dispatch rail's signal without
// its noise. One clamped line per plan, newest first.
export function ActionCards({ width }: { width: number }) {
  const [plans, setPlans] = useState<ReturnType<typeof listPlans>>([]);
  useEffect(() => {
    const load = () => { try { setPlans(listPlans().slice(0, 3)); } catch { /* store unreadable */ } };
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  if (!plans.length) {
    return <Text color={theme.textTertiary} wrap="truncate">{truncateVisible('no dispatched plans yet — compile a mission and J-BANG it', width)}</Text>;
  }
  return (
    <Box flexDirection="column" flexShrink={0}>
      {plans.map(p => {
        const life = LIFE_GLYPH[p.lifecycle] ?? { g: '·', c: theme.textTertiary };
        const line = `[J-BANG] ${p.id.slice(0, 14)} · ${p.plan.harnesses[0]} · ${p.plan.workspace.kind} · ${p.lifecycle} · sha:${p.plan_hash.slice(0, 8)}`;
        return (
          <Text key={p.id} color={theme.textSecondary} wrap="truncate">
            <Text color={life.c}>{life.g}</Text> {truncateVisible(line, Math.max(24, width - 4))}
          </Text>
        );
      })}
    </Box>
  );
}
