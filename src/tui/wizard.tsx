// ui-next-2 — `timmy init` wizard screen: five steps (store, operator, edge
// host, commander ws, model policy). Values resolve overlay → env → default;
// [e] edits the selected step, [w] writes the private overlay config. Under
// TIMMY_DEMO / TIMMY_WIZARD_DRY the write is a dry run (tests, captures).
import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { theme } from './theme.js';

const PAL = theme;
const overlayPath = (): string => join(process.cwd(), '.timmy', 'private', 'config.json');
const readOverlay = (): Record<string, unknown> => {
  try { return JSON.parse(readFileSync(overlayPath(), 'utf8')) as Record<string, unknown>; } catch { return {}; }
};

export interface WizardStep { id: string; label: string; value: () => string; key: string | null }

export function WizardScreen() {
  const { exit } = useApp();
  const [sel, setSel] = useState(0);
  const [edit, setEdit] = useState(false);
  const [input, setInput] = useState('');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [note, setNote] = useState('fresh install wizard — [e] edit · [Enter] next · [w] write · [q] quit');
  const ov = readOverlay();
  const steps: WizardStep[] = [
    { id: 'store', label: 'store', value: () => join(process.cwd(), '.timmy', 'receipts'), key: null },
    { id: 'operator', label: 'operator', value: () => vals.operator ?? String(ov.operator_label ?? process.env.TIMMY_OPERATOR ?? 'operator'), key: 'operator_label' },
    { id: 'edge', label: 'edge host', value: () => vals.edge ?? String(ov.edge_host ?? process.env.TIMMY_EDGE_HOST ?? ''), key: 'edge_host' },
    { id: 'commander', label: 'commander ws', value: () => vals.commander ?? String(ov.commander_ws ?? process.env.TIMMY_COMMANDER_WS ?? ''), key: 'commander_ws' },
    { id: 'policy', label: 'model policy', value: () => vals.policy ?? 'openrouter/auto', key: 'policy' },
  ];
  useInput((key, k) => {
    if (edit) {
      if (k.escape) { setEdit(false); setInput(''); return; }
      if (k.return) {
        setVals(v => ({ ...v, [steps[sel].id]: input }));
        setEdit(false); setInput('');
        setNote(`${steps[sel].label} set`);
        return;
      }
      if (k.backspace || k.delete) { setInput(i => i.slice(0, -1)); return; }
      if (key && !k.ctrl && !k.meta) setInput(i => i + key);
      return;
    }
    if (key === 'q') { exit(); return; }
    if (k.upArrow || key === 'k') setSel(s => Math.max(0, s - 1));
    if (k.downArrow || key === 'j') setSel(s => Math.min(steps.length - 1, s + 1));
    if (key === 'e' && steps[sel].key) { setEdit(true); setInput(steps[sel].value()); return; }
    if (k.return && sel < steps.length - 1) { setSel(s => s + 1); return; }
    if (key === 'w') {
      const dry = process.env.TIMMY_DEMO === '1' || process.env.TIMMY_WIZARD_DRY === '1';
      const next = { ...ov };
      for (const st of steps) if (st.key) next[st.key] = st.value();
      if (dry) { setNote('dry run — overlay not written (TIMMY_DEMO/TIMMY_WIZARD_DRY)'); return; }
      try {
        mkdirSync(join(process.cwd(), '.timmy', 'private'), { recursive: true });
        writeFileSync(overlayPath(), JSON.stringify(next, null, 1));
        setNote(`overlay written · ${overlayPath()}`);
      } catch (e) {
        setNote(`overlay write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold color={PAL.textPrimary}>TIMMY INIT — setup wizard</Text>
      <Text color={PAL.textMuted}>────────────────────────────────────────</Text>
      {steps.map((st, i) => (
        <Text key={st.id} color={i === sel ? PAL.seal : PAL.textSecondary}>
          {`${i === sel ? '▶' : ' '} ${String(i + 1)} ${st.label.padEnd(13)} ${edit && i === sel ? `[${input}]` : st.value().slice(0, 44) || '—'}`}
        </Text>
      ))}
      <Text color={PAL.textMuted}>────────────────────────────────────────</Text>
      <Text color={PAL.warn}>{note}</Text>
      <Text color={PAL.textMuted}>[↑↓] step · [e] edit · [Enter] next · [w] write overlay · [q] quit</Text>
    </Box>
  );
}
