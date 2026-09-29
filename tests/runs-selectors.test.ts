import { describe, it, expect } from 'vitest';
import { sparkBuckets, sparkString } from '../src/tui/components/Sparkline.js';
import { statusGlyph } from '../src/tui/components/StatusGlyph.js';
import {
  stepTimeline,
  runHistoryFromLogs,
  mergeRunLists,
  liveRunSummary,
  sessionCost,
  type RunStep
} from '../src/hermes/selectors.js';
import type { HermesEvent } from '../src/hermes/events.js';
import type { HermesStoreSnapshot } from '../src/hermes/store.js';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');

const ev = (type: HermesEvent['type'], at: string, payload: Record<string, unknown> = {}, id = `e${Math.random()}`): HermesEvent => ({
  id,
  runId: 'run_x',
  sessionId: 's1',
  type,
  timestamp: at,
  payload
});

describe('sparkline', () => {
  it('buckets events into the right slots', () => {
    const b = sparkBuckets(['2026-08-12T12:00:00Z', '2026-08-12T11:59:30Z', '2026-08-12T11:50:00Z'], NOW, 12, 60_000);
    expect(b).toHaveLength(12);
    expect(b[11]).toBe(2); // current minute
    expect(b[10]).toBe(0);
    expect(b[1]).toBe(1); // 10 minutes ago → index 12-1-10
  });

  it('renders a deterministic block string', () => {
    expect(sparkString([0, 0, 4])).toBe('  █');
    expect(sparkString([])).toBe('');
  });
});

describe('status glyphs', () => {
  it('is a single source of truth, and its glyphs are the evidence marks (C1b-2)', () => {
    expect(statusGlyph('running').glyph).toBe('●'); // constructed
    expect(statusGlyph('sealed').glyph).toBe('✓');  // checked
    expect(statusGlyph('queued').glyph).toBe('○');  // declared
    expect(statusGlyph('failed').glyph).toBe('×');  // refuse
    expect(statusGlyph('missing').label).toBe('not installed');
  });
});

describe('step timeline', () => {
  it('pairs tool start/complete into one elapsed step', () => {
    const steps = stepTimeline([
      ev('tool.start', '2026-08-12T12:00:00Z', { toolCallId: 't1', name: 'edit' }),
      ev('tool.complete', '2026-08-12T12:00:12Z', { toolCallId: 't1', name: 'edit' })
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].glyph).toBe('✓');
    expect(steps[0].text).toBe('tool edit');
    expect(steps[0].elapsedMs).toBe(12_000);
  });

  it('shows approvals, fallbacks and model switches as trust-story steps', () => {
    const steps: RunStep[] = stepTimeline([
      ev('approval.request', '2026-08-12T12:00:00Z', { title: 'rm -rf dist' }),
      ev('approval.response', '2026-08-12T12:00:05Z', { decision: 'approved' }),
      ev('provider.route', '2026-08-12T12:00:06Z', { provider: 'openrouter', status: 'failed', reason: 'rate limited' }),
      ev('provider.route', '2026-08-12T12:00:07Z', { provider: 'ollama', status: 'fallback', model: 'qwen3' }),
      ev('model.switch', '2026-08-12T12:00:08Z', { model: 'qwen/qwen3.8-max' })
    ]);
    expect(steps.map(s => s.glyph).join('')).toBe('⚠✓×▸▸');
    expect(steps[0].text).toContain('rm -rf dist');
    expect(steps[3].text).toContain('fallback → qwen3');
  });

  it('ignores stream deltas', () => {
    expect(stepTimeline([ev('message.delta', '2026-08-12T12:00:00Z', {}), ev('message.complete', '2026-08-12T12:00:01Z', {})]).length).toBe(0);
  });
});

describe('run history + merge', () => {
  it('parses run.created lines from the tui log', () => {
    // log files append chronologically (oldest first) — the selector reverses
    const runs = runHistoryFromLogs([
      '[2026-08-12T09:00:00.000Z] [INFO] [run.created] {"runId":"run_b","source":"timmy"}',
      'noise line',
      '[2026-08-12T10:00:00.000Z] [INFO] [run.created] {"runId":"run_a","source":"timmy-studio","prompt":"sting"}'
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe('run_a'); // newest first
    expect(runs[0].source).toBe('studio');
    expect(runs[1].status).toBe('completed');
  });

  it('puts the live run first and dedupes', () => {
    const live = { id: 'run_a', at: '', source: 'hermes', status: 'running' as const };
    const merged = mergeRunLists(live, [
      { id: 'run_a', at: '', source: 'hermes', status: 'completed' as const },
      { id: 'run_b', at: '', source: 'tui', status: 'completed' as const }
    ]);
    expect(merged.map(r => r.id)).toEqual(['run_a', 'run_b']);
    expect(merged[0].status).toBe('running');
  });

  it('reads live run + cost from the store snapshot', () => {
    const snap = {
      run: { id: 'run_x', sessionId: 's', status: 'running', createdAt: '2026-08-12T11:00:00Z', updatedAt: '2026-08-12T11:00:00Z', model: 'qwen/qwen3.8-max' },
      usage: { costUsd: 0.0213, inputTokens: 10, outputTokens: 20 },
      events: [], eventCount: 0, toolCallCount: 0, approvalCount: 0, openApprovals: [], approvals: [], routes: [], streamText: ''
    } as unknown as HermesStoreSnapshot;
    expect(liveRunSummary(snap)?.status).toBe('running');
    expect(sessionCost(snap)).toBeCloseTo(0.0213);
  });
});
