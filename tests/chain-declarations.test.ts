import { describe, expect, it } from 'vitest';
import { typedLines } from '../src/tui/chain-views.js';
import { visibleWidth } from '../src/tui/utils/text.js';
import type { Receipt } from '../src/utils/receipts.js';

function receipt(subject: string, fields: Record<string, unknown>): Receipt {
  return { subject, sources: [fields] } as Receipt;
}

describe('historical declaration projections', () => {
  it('labels stored judgment claims unverified and preserves raw model output/refusal', () => {
    const raw = { predicted: 'two parts', actual: 'refused: no handles', difference: 'unknown', refusal: true };
    const r = receipt('judgment.geometry', raw);
    const before = JSON.stringify(r);
    const lines = typedLines(r);
    expect(lines[0]).toBe('  historical declaration · unverified');
    expect(lines.join('\n')).toContain('refused: no handles');
    expect(lines.join('\n')).toContain('unknown');
    expect(JSON.stringify(r)).toBe(before);
  });

  it('shows unknown missing fields without manufacturing handles or success', () => {
    expect(typedLines(receipt('judgment.fixture', {}))).toEqual([
      '  historical declaration · unverified', '  pred —', '  act  —', '  diff —',
    ]);
    const lines = typedLines(receipt('studio.preserve', { studio: 'fixture', proj: 'sample', assets: 3 }));
    expect(lines[0]).toContain('unverified');
    expect(lines[1]).toContain('sample');
    expect(lines[2]).toContain('assets 3');
  });

  it('bounds wide text and removes terminal controls from projections only', () => {
    const hostile = '\u001b]52;c;fixture\u0007\u001b[31m\n\r\b\u009b\u202e' + '界'.repeat(100);
    for (const subject of ['judgment.fixture', 'studio.preserve']) {
      const fields = { predicted: hostile, actual: hostile, difference: hostile, studio: hostile, project: hostile, assets: hostile, sha256: hostile };
      const r = receipt(subject, fields);
      for (const line of typedLines(r)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(42);
        expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
      }
      expect(r.sources).toEqual([fields]);
      expect(fields.predicted).toBe(hostile);
    }
  });
});
