import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prepareGoldenWorkflow, runComfyGolden, comfyPreflight, GOLDEN_SEED } from '../src/utils/comfy-adapter.js';
import { comfyPresent } from './service-gate.js';

const GOLDEN = JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'comfy-golden-5s.json'), 'utf8'));

describe.skipIf(!comfyPresent())('comfy golden-run adapter (V-04 spike)', () => {
  it('pins every seed and injects the discovered checkpoint at the DISCOVER sentinel', () => {
    const prepared = prepareGoldenWorkflow(GOLDEN, { seed: 42, checkpoint: 'real_ckpt.safetensors' }) as any;
    expect(prepared['3'].inputs.seed).toBe(42);
    expect(prepared['1'].inputs.ckpt_name).toBe('real_ckpt.safetensors');
    // non-sentinel fields untouched
    expect(prepared['3'].inputs.steps).toBe(4);
    expect(prepared['7'].inputs.filename_prefix).toBe('timmy-golden-5s');
  });

  it('defaults to GOLDEN_SEED and leaves DISCOVER alone without a discovery result', () => {
    const prepared = prepareGoldenWorkflow(GOLDEN, {}) as any;
    expect(prepared['3'].inputs.seed).toBe(GOLDEN_SEED);
    expect(prepared['1'].inputs.ckpt_name).toBe('DISCOVER');
  });

  it('is pure: input workflow object is not mutated', () => {
    const before = JSON.stringify(GOLDEN);
    prepareGoldenWorkflow(GOLDEN, { seed: 7, checkpoint: 'x' });
    expect(JSON.stringify(GOLDEN)).toBe(before);
  });

  it('fails closed with missing_source on a nonexistent workflow', async () => {
    if (!comfyPreflight().ok) return; // CLI absent → covered by the not_configured path
    const r = await runComfyGolden({ workflow: 'no-such-workflow.json' });
    expect(r.ok).toBe(false);
    expect(r.error_class).toBe('missing_source');
    expect(r.receipt).toMatch(/^sha256_/);
  });
});
