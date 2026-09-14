import React, { useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import { useFocus, panelMayAct } from '../hooks/useKeyDispatcher.js';
import { spawnSync } from 'child_process';
import { LANE_RUNNERS } from '../../agent/lanes.js';
import { PaneFocusContext } from '../components/PanelFrame.js';
import { Card } from '../ui/index.js';
import {
  createPlan, armPlan, dispatchPlan, tailLane, pauseOrCancelLane, collectRun,
  type DispatchPlan, type StoredPlan
} from '../../utils/dispatch.js';
import { theme } from '../theme.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Command Post v0.1 — compact Dispatch rail (J-BANG: Job Bundle, Authorization,
// Navigation and Guarantees). Extends ChatPanel; never replaces it. The exact
// plan hash is shown before launch (8-char truncation, [x] expand, [y] copy);
// launch requires an operator token. Every line truncates to the rail width so
// the reverse LogRain beside it never clips.
export function DispatchRail({ width }: { width: number }) {
  const harnessIds = Object.keys(LANE_RUNNERS);
  const [hIdx, setHIdx] = useState(0);
  const [copies, setCopies] = useState(1);
  const [wallS, setWallS] = useState(300);
  const [budget, setBudget] = useState(0);
  const [objective, setObjective] = useState('');
  const [typing, setTyping] = useState(false);
  const [planId, setPlanId] = useState<string | null>(null);
  const [planHash, setPlanHash] = useState<string | null>(null);
  const [expandHash, setExpandHash] = useState(false);
  const [armed, setArmed] = useState(false);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('rail: [o] objective · [h] harness · [+-] copies/budget/wall · [p] plan · [g] arm+launch (J-BANG) · [t] tail · [c] cancel');

  const stored = useMemo<StoredPlan | null>(() => {
    if (!planId) return null;
    try { return JSON.parse(readFileSync(join(process.cwd(), '.timmy', 'dispatch', `${planId}.json`), 'utf8')); } catch { return null; }
  }, [planId, msg]);

  const __focus = useFocus();
  useInput((char, key) => {
    if (!panelMayAct(__focus, 'input:dispatch')) return;
    if (typing) {
      if (key.return) { setTyping(false); return; }
      if (key.backspace || key.delete) { setObjective(o => o.slice(0, -1)); return; }
      if (key.escape) { setTyping(false); return; }
      setObjective(o => o + char);
      return;
    }
    switch (char) {
      case 'o': setTyping(true); setMsg('type objective, Enter to commit'); break;
      case 'h': setHIdx(i => (i + 1) % harnessIds.length); break;
      case '+': setCopies(c => Math.min(8, c + 1)); break;
      case '-': setCopies(c => Math.max(1, c - 1)); break;
      case 'w': setWallS(w => (w === 300 ? 900 : 300)); break;
      case '$': setBudget(b => (b === 0 ? 0.5 : 0)); break;
      case 'x': setExpandHash(e => !e); break;
      case 'y': {
        if (!planHash) { setMsg('no plan hash yet — [p] first'); break; }
        const c = spawnSync('pbcopy', { input: planHash });
        setMsg(c.status === 0 ? `hash copied (${planHash.slice(0, 8)}…)` : 'clipboard unavailable on this platform');
        break;
      }
      case 'p': {
        const plan: DispatchPlan = {
          schema_version: 'dispatch/0.1',
          objective: objective || '(no objective)',
          deliverables: ['result'], acceptance_tests: ['see collect'],
          harnesses: [harnessIds[hIdx]],
          model_policy: { requested: LANE_RUNNERS[harnessIds[hIdx]].model ?? 'auto', allow_paid: budget > 0, max_spend_usd: budget },
          copies, cadence: { mode: 'parallel', depends_on: [] },
          context_manifest: [], repo_ref: 'HEAD',
          workspace: { kind: 'host-ephemeral' },
          permissions: { filesystem: 'rw-ephemeral', network: budget > 0, tools: [], secrets: [] },
          limits: { cost_usd: budget, wall_ms: wallS * 1000 },
          retry_limit: 1, approval: { required: true, mode: 'manual' },
          expected_artifacts: [], telemetry: { redact: true, events: true }
        };
        const r = createPlan(plan);
        if (r.ok) { setPlanId(r.id!); setPlanHash(r.plan_hash!); setArmed(false); setMsg(`plan ${r.id} · hash ${r.plan_hash} · operator: timmy approve ${r.plan_hash}`); }
        else setMsg(`plan rejected: ${r.note}`);
        break;
      }
      case 'g': {
        if (!planId || !planHash) { setMsg('create a plan first [p]'); break; }
        if (!token) { setMsg(`J-BANG needs the operator token for ${planHash.slice(0, 12)}… (paste via [v] after \`timmy approve\`)`); break; }
        const a = armPlan(planId, token.trim());
        if (!a.ok) { setMsg(`arm denied: ${a.note}`); break; }
        const d = dispatchPlan(planId);
        setArmed(d.ok);
        setMsg(d.ok ? `J-BANG! launched ${d.session}` : `launch refused: ${d.note ?? d.blocked?.note}`);
        break;
      }
      case 'v': setTyping(true); setMsg('paste approval token, Enter'); setToken(''); break;
      case 't': {
        const t = planId ? tailLane(planId) : null;
        setMsg(t?.ok ? (t.lines ?? []).slice(-3).join(' | ').slice(0, 120) : 'no lane');
        break;
      }
      case 'c': {
        const x = planId ? pauseOrCancelLane(planId, 'cancel') : null;
        setMsg(x?.ok ? 'cancelled · receipt sealed' : 'nothing to cancel');
        break;
      }
      case 'j': {
        const c = planId ? collectRun(planId) : null;
        setMsg(c?.ok ? `collected · over_wall=${c.over_wall} · receipt ${String(c.receipt).slice(0, 12)}…` : 'nothing to collect');
        break;
      }
    }
  });

  const harness = harnessIds[hIdx];
  const sandbox = stored?.plan.workspace.kind ?? 'host-ephemeral';
  const thermFilled = budget <= 0 ? 0 : Math.min(5, Math.max(1, Math.round(budget * 2)));
  const therm = '▮'.repeat(thermFilled) + '░'.repeat(5 - thermFilled);
  const focused = React.useContext(PaneFocusContext);
  return (
    <Card
      title="Dispatch · J-Bang"
      focused={focused}
      purpose="plan, arm, launch harness lanes — operator token gated"
      pill={armed ? { kind: 'accent', label: 'ARMED' } : planId ? { kind: 'warn', label: 'PLANNED' } : { kind: 'muted', label: 'IDLE' }}
      width={width}
    >
      <Text color={theme.textSecondary} wrap="truncate">harness  <Text color={theme.textPrimary}>{harness}</Text> ({LANE_RUNNERS[harness].label})</Text>
      <Text color={theme.textSecondary} wrap="truncate">copies   <Text color={theme.textPrimary}>{copies}</Text> · wall <Text color={theme.textPrimary}>{wallS}s</Text> · <Text color={theme.accent}>{therm} ${budget}</Text></Text>
      <Text color={theme.textSecondary} wrap="truncate">sandbox  <Text color={theme.accent}>{sandbox}</Text> · never the live checkout</Text>
      <Text color={theme.textSecondary} wrap="truncate">objective <Text color={theme.textPrimary}>{objective.slice(0, Math.max(8, width - 14)) || '—'}</Text></Text>
      <Text color={theme.textSecondary} wrap="truncate">plan     <Text color={theme.textPrimary}>{planId ?? '—'}</Text> · {stored?.lifecycle ?? 'draft'}</Text>
      <Text color={theme.textSecondary} wrap="truncate">hash     <Text color={theme.textPrimary}>{planHash ? (expandHash ? planHash : planHash.slice(0, 8) + '…') : '— shown before launch'}</Text>{planHash ? <Text color={theme.textMuted}> [y]copy [x]{expandHash ? 'fold' : 'expand'}</Text> : null}</Text>
      <Text color={theme.textSecondary} wrap="truncate">armed    <Text color={armed ? theme.accent : theme.textMuted}>{armed ? 'yes' : 'no'}</Text></Text>
      <Text color={theme.textMuted} wrap="truncate">{msg}</Text>
    </Card>
  );
}
