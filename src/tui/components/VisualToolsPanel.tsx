import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Card } from '../ui/Card.js';
import { BudgetList } from '../ui/BudgetList.js';
import { theme } from '../theme.js';

export type VisualToolId = 'camera-fit' | 'opensplat-inspect' | 'motion-html' | 'otlp-export' | 'dmux';
export type VisualToolAction = Exclude<VisualToolId, 'dmux'>;
export type VisualToolAvailability = 'available' | 'not-installed' | 'unavailable' | 'unknown';
export interface VisualToolRunState {
  toolId?: VisualToolId;
  status: 'idle' | 'running' | 'completed' | 'refused' | 'failed';
  summary?: string;
  artifactPath?: string;
  receiptId?: string;
}
export interface VisualToolsPanelProps {
  active: boolean;
  height?: number;
  availability?: Partial<Record<VisualToolId, VisualToolAvailability>>;
  runState?: VisualToolRunState;
  onRun: (id: VisualToolAction, inputPath?: string) => Promise<void>;
  onBack?: () => void;
  onOpenArtifact?: (path: string) => void;
}

const entries: { id: VisualToolId; name: string; action: string; input?: string; example?: string; description: string }[] = [
  { id: 'camera-fit', name: 'Camera alignment', action: 'Run', input: 'Request JSON path', example: 'examples/visual-tools/camera-fit.json', description: 'Reconstruct pose from correspondences; report independent validation residuals.' },
  { id: 'opensplat-inspect', name: 'Gaussian inspection', action: 'Inspect', input: 'PLY path', example: 'examples/visual-tools/parameters.ply', description: 'Inspect a Gaussian PLY file. Appearance is not solid occupancy.' },
  { id: 'motion-html', name: 'Motion HTML', action: 'Create preview', input: 'Storyboard JSON path', example: 'examples/visual-tools/storyboard.json', description: 'Create seekable HTML from a storyboard; preserve editable source.' },
  { id: 'otlp-export', name: 'Telemetry', action: 'Export OTLP', description: 'Write a local metadata-only OTLP export. Nothing is transmitted.' },
  { id: 'dmux', name: 'dmux', action: 'Catalog only', description: 'Harness multiplexer inventory. This panel does not launch agents or auto-merge.' },
];

/** Fixed actions only. The host owns execution, authorization, receipts and artifact opening. */
export function VisualToolsPanel({ active, height = 22, availability = {}, runState,
  onRun, onBack, onOpenArtifact }: VisualToolsPanelProps) {
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState(false);
  const [paths, setPaths] = useState<Partial<Record<VisualToolId, string>>>({});
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<VisualToolAction | null>(null);
  const locked = useRef(false);
  const entry = entries[selected];
  const path = paths[entry.id] ?? '';
  const available = availability[entry.id] ?? 'unknown';
  const result = runState?.toolId === entry.id && pending !== entry.id ? runState : undefined;
  const busy = pending !== null || runState?.status === 'running';
  const status = pending === entry.id ? 'running' : result?.status ?? 'idle';

  async function run() {
    if (locked.current || busy || entry.id === 'dmux') return;
    if (available === 'unavailable' || available === 'not-installed') {
      setNotice('Unavailable: this action cannot run with the detected local setup.'); return;
    }
    if (entry.input && !path.trim()) { setNotice('Enter one local file path first.'); return; }
    locked.current = true;
    setPending(entry.id);
    setNotice('');
    try { await onRun(entry.id, entry.input ? path.trim() : undefined); }
    catch { setNotice('FAILED: execution did not complete. Inspect the host result.'); }
    finally { locked.current = false; setPending(null); }
  }

  useInput((input, key) => {
    if (!active) return;
    if (key.escape) {
      if (detail) { setDetail(false); setNotice(''); }
      else onBack?.();
      return;
    }
    if (!detail) {
      if (key.upArrow) setSelected(value => (value + entries.length - 1) % entries.length);
      else if (key.downArrow) setSelected(value => (value + 1) % entries.length);
      else if (key.return) { setDetail(true); setNotice(''); }
      return;
    }
    if (key.return) { void run(); return; }
    if (key.ctrl && input === 'o' && result?.artifactPath && onOpenArtifact) {
      onOpenArtifact(result.artifactPath); return;
    }
    if (busy || !entry.input || key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) return;
    if (key.backspace || key.delete) {
      setPaths(previous => ({ ...previous, [entry.id]: Array.from(previous[entry.id] ?? '').slice(0, -1).join('') }));
      return;
    }
    const pasted = input.replace(/\x1b\[(?:200|201)~/g, '');
    if (/[\x00-\x1f\x7f]/.test(pasted)) { setNotice('Use one path; multiline or control input was refused.'); return; }
    if (path.length + pasted.length > 4096) { setNotice('Path exceeds 4096 characters.'); return; }
    setPaths(previous => ({ ...previous, [entry.id]: ((previous[entry.id] ?? '') + pasted).slice(0, 4096) }));
    setNotice('');
  }, { isActive: active });

  const maximum = Math.max(1, Math.min(5, height - 9));
  const pillKind = status === 'refused' || status === 'failed' ? 'danger'
    : busy ? 'warn' : 'muted';
  return <Card title="Visual tools" focused={active} height={height}
    purpose={detail ? entry.name : 'Choose a local tool, inspect its input, then run.'}
    pill={{ kind: pillKind, label: detail ? status.toUpperCase() : busy ? 'RUNNING' : 'LOCAL' }}>
    {!detail ? <>
      <BudgetList items={entries} max={maximum} offset={Math.max(0, selected - maximum + 1)} render={(item, index) =>
        <Text color={selected === index ? theme.accent : theme.textPrimary} wrap="truncate-end">
          {selected === index ? '› ' : '  '}{item.name} · {availability[item.id] ?? 'unknown'}{item.id === 'dmux' ? ' · catalog only' : ''}
        </Text>} />
      <Box height={1} /><Text color={theme.textMuted}>↑↓ choose · Enter details · Esc back</Text>
    </> : <>
      <Text color={theme.textSecondary} wrap="truncate-end">{entry.description}</Text>
      <Text color={theme.textMuted}>Local availability: {available}</Text>
      {entry.input ? <><Text color={theme.textPrimary}>{entry.input}</Text>
        <Text color={theme.textMuted} wrap="truncate-middle">Example: {entry.example}</Text>
        <Text color={theme.accent} wrap="truncate-start">{path || 'Paste or type a path'}{active && !busy ? ' ▏' : ''}</Text></> : null}
      <Text color={busy ? theme.warn : theme.accent}>{entry.id === 'dmux' ? 'CATALOG ONLY · no launch action' : busy ? 'RUNNING · another start is disabled' : `[Enter] ${entry.action}`}</Text>
      {notice ? <Text color={theme.warn} wrap="truncate-end">{notice}</Text> : null}
      {result?.summary ? <Text color={status === 'refused' || status === 'failed' ? theme.danger : theme.textPrimary} wrap="truncate-end">{status.toUpperCase()}: {result.summary}</Text> : null}
      {status === 'completed' ? <Text color={theme.textMuted}>Completion is not geometry verification.</Text> : null}
      {result?.artifactPath ? <Text color={theme.textSecondary} wrap="truncate-middle">Artifact: {result.artifactPath}</Text> : null}
      {result?.receiptId ? <Text color={theme.textSecondary} wrap="truncate-end">Receipt: {result.receiptId}</Text> : null}
      <Text color={theme.textMuted}>Esc list{result?.artifactPath && onOpenArtifact ? ' · Ctrl+O open artifact' : ''}{entry.input ? ' · Backspace edit' : ''}</Text>
    </>}
  </Card>;
}
