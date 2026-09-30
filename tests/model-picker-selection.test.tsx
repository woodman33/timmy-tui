import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ModelsPane } from '../src/tui/components/ShellV2.js';
import type { ModelEntry } from '../src/models/registry.js';

// Render only the picker: no shell effects, model calls, policy or receipt writes.
const models: ModelEntry[] = Array.from({ length: 12 }, (_, i) => ({ id: `fixture-model-${i}` }));

describe('model picker cursor and role headers', () => {
  it.each([4, 5, 8, 16])('keeps the actionable model selected within a %i-row grouped window', maxRows => {
    const view = models.flatMap((m, i) => i % 3 === 0 ? [{ role: `group-${i}` }, { m }] : [{ m }]);
    for (let selected = 0; selected < models.length; selected++) {
      const rendered = render(<ModelsPane view={view} selected={selected} sel={models[selected]} filter="" compact maxRows={maxRows} />);
      try {
        const frame = rendered.lastFrame() ?? '';
        const marked = frame.split('\n').filter(row => row.includes('▶'));
        expect(marked, `cursor ${selected}: ${frame}`).toHaveLength(1);
        expect(marked[0]).toContain(`▶ ${models[selected].id.padEnd(20)}`);
        const listRows = frame.split('\n').filter(row => row.includes('role:') || row.includes('fixture-model-'));
        expect(listRows.length).toBeLessThanOrEqual(maxRows);
      } finally { rendered.unmount(); }
    }
  });

  it('keeps selection visible when every model has its own role header', () => {
    const view = models.flatMap((m, i) => [{ role: `group-${i}` }, { m }]);
    for (let selected = 0; selected < models.length; selected++) {
      const rendered = render(<ModelsPane view={view} selected={selected} sel={models[selected]} filter="" compact maxRows={4} />);
      try {
        const frame = rendered.lastFrame() ?? '';
        expect(frame, `cursor ${selected}`).toContain(`▶ ${models[selected].id.padEnd(20)}`);
        expect(frame.split('\n').filter(row => row.includes('role:') || row.includes('fixture-model-')).length).toBeLessThanOrEqual(4);
      } finally { rendered.unmount(); }
    }
  });

  it('counts models without role headers and handles an empty filtered list', () => {
    const view = [{ role: 'fixture' }, ...models.slice(0, 2).map(m => ({ m }))];
    const rendered = render(<ModelsPane view={view} selected={0} sel={models[0]} filter="" compact={false} />);
    try { expect(rendered.lastFrame()).toContain('2 models'); }
    finally { rendered.unmount(); }
    const empty = render(<ModelsPane view={[]} selected={0} sel={null} filter="none" compact />);
    try {
      expect(empty.lastFrame()).toContain('no models match');
      expect(empty.lastFrame()).not.toContain('▶');
    } finally { empty.unmount(); }
  });
});
