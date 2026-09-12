import { describe, it, expect } from 'vitest';
import { runEscrowBench } from '../src/utils/escrow-bench.js';
import { dockerPresent } from './service-gate.js';

describe.skipIf(!dockerPresent())('V-03 graduation benchmark', () => {
  it('settle + cancel honor refund = ceiling − drawn; chain walks; tamper slashes', () => {
    const r = runEscrowBench();
    expect(r.ok).toBe(true);
    expect(r.graduated).toBe(true);
    expect(r.lifecycle_refund).toBe(0.75);
    expect(r.cancel_refund).toBe(1.5);
    expect(r.tamper_slashed).toBe(true);
    expect(r.chain_ok).toBe(true);
    expect(r.escrow_ids).toHaveLength(3);
  });
});
