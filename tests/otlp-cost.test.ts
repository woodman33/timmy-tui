import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendReceipt } from '../src/utils/receipts.js';
import { receiptsToOtlp } from '../src/utils/otlp.js';

describe('OTLP cost knowledge', () => {
  it('exports measured zero but never exports an unknown placeholder as money', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-cost-otlp-'));
    try {
      for (const cost of [{ cost_usd: 0, cost_measured: true }, { cost_usd: 12, cost_measured: false }, {}]) {
        appendReceipt('gens', { kind: 'generation', subject: 'synthetic', policy: 'auto', ...cost }, dir);
      }
      const result = receiptsToOtlp(['gens'], dir) as { resourceSpans: { scopeSpans: { spans: { attributes: { key: string; value: unknown }[] }[] }[] }[] };
      const attrs = result.resourceSpans[0].scopeSpans[0].spans.map(s => Object.fromEntries(s.attributes.map(a => [a.key, a.value])));
      expect(attrs[0]['timmy.cost_usd']).toEqual({ doubleValue: 0 });
      expect(attrs[0]['timmy.cost_measured']).toEqual({ boolValue: true });
      expect(attrs[1]['timmy.cost_usd']).toBeUndefined();
      expect(attrs[1]['timmy.cost_measured']).toEqual({ boolValue: false });
      expect(attrs[1]['timmy.cost_state']).toEqual({ stringValue: 'declared-unknown' });
      expect(attrs[2]['timmy.cost_usd']).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
