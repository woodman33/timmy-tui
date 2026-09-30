import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendReceipt, verifyChain, readChain, receiptsPath, measuredCostUsd, declaredUnknownCostUsd, formatCostUsd } from '../src/utils/receipts.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-receipts-'));
});

describe('receipt chain v1', () => {
  it('links receipts with prev_hash from genesis', () => {
    const a = appendReceipt('gens', { kind: 'generation', subject: 'g1', policy: 'human-gated' }, dir);
    const b = appendReceipt('gens', { kind: 'generation', subject: 'g2', policy: 'human-gated' }, dir);
    expect(a.prev_hash).toBe('genesis');
    expect(b.prev_hash).toBe(a.hash);
    expect(a.hash).toMatch(/^sha256_[0-9a-f]{64}$/);
  });

  it('verifies an intact chain', () => {
    appendReceipt('gens', { kind: 'generation', subject: 'g1', policy: 'auto' }, dir);
    appendReceipt('gens', { kind: 'generation', subject: 'g2', cost_usd: 0.22, policy: 'auto' }, dir);
    const r = verifyChain('gens', dir);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
  });

  it('detects body tampering', () => {
    appendReceipt('gens', { kind: 'generation', subject: 'g1', cost_usd: 0.22, policy: 'auto' }, dir);
    appendReceipt('gens', { kind: 'generation', subject: 'g2', policy: 'auto' }, dir);
    const p = receiptsPath('gens', dir);
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]);
    first.cost_usd = 0.01; // tamper
    writeFileSync(p, [JSON.stringify(first), ...lines.slice(1)].join('\n') + '\n');
    const r = verifyChain('gens', dir);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('tampered');
  });

  it('detects a broken chain link', () => {
    appendReceipt('gens', { kind: 'generation', subject: 'g1', policy: 'auto' }, dir);
    appendReceipt('gens', { kind: 'generation', subject: 'g2', policy: 'auto' }, dir);
    const p = receiptsPath('gens', dir);
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const second = JSON.parse(lines[1]);
    second.prev_hash = 'sha256_deadbeef';
    writeFileSync(p, [lines[0], JSON.stringify(second)].join('\n') + '\n');
    const r = verifyChain('gens', dir);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('chain link broken');
  });

  it('empty chain verifies', () => {
    expect(verifyChain('runs', dir)).toEqual({ ok: true, count: 0, current_epoch: 1, segments: [] });
    expect(readChain('runs', dir)).toEqual([]);
  });
});

describe('evidence-rule cost accounting (measuredCostUsd / declaredUnknownCostUsd)', () => {
  it('sums measured costs and skips declared-unknown placeholders', () => {
    const recs = [
      { cost_usd: 0.42 },
      { cost_usd: 0, cost_measured: true },      // genuinely measured $0
      { cost_usd: 0, cost_measured: false },     // placeholder, not a real zero
      { cost_usd: 0.18, cost_measured: false },  // placeholder even if non-zero
    ];
    expect(recs.reduce((n, r) => n + measuredCostUsd(r), 0)).toBeCloseTo(0.42);
    expect(recs.reduce((n, r) => n + declaredUnknownCostUsd(r), 0)).toBe(2);
  });

  it('treats a missing cost_measured flag as measured (legacy receipts)', () => {
    expect(measuredCostUsd({ cost_usd: 0.05 })).toBe(0.05);
    expect(declaredUnknownCostUsd({ cost_usd: 0.05 })).toBe(0);
  });

  it('handles malformed cost_usd without NaN leaks', () => {
    expect(measuredCostUsd({ cost_usd: Number.NaN })).toBe(0);
    expect(measuredCostUsd({ cost_usd: Number.POSITIVE_INFINITY })).toBe(0);
    expect(measuredCostUsd({ cost_usd: '0.10' as unknown as number })).toBe(0);
    expect(measuredCostUsd({})).toBe(0);
    expect(declaredUnknownCostUsd({ cost_usd: Number.NaN, cost_measured: false })).toBe(1);
  });

  it('aggregates measured sums via the chain the way aggregators do', () => {
    appendReceipt('runs', { kind: 'gen.result', subject: 'measured', policy: 'auto', cost_usd: 0.30 }, dir);
    appendReceipt('runs', { kind: 'gen.result', subject: 'placeholder', policy: 'auto', cost_usd: 0, cost_measured: false }, dir);
    const chain = readChain('runs', dir);
    expect(chain.reduce((n, r) => n + measuredCostUsd(r), 0)).toBeCloseTo(0.30);
    expect(chain.reduce((n, r) => n + declaredUnknownCostUsd(r), 0)).toBe(1);
  });
});


describe('cost knowledge display', () => {
  it('distinguishes measured zero, placeholders, invalid charges, and missing prices', () => {
    expect(formatCostUsd({ cost_usd: 0, cost_measured: true }, 2)).toBe('$0.00');
    expect(formatCostUsd({ cost_usd: 0, cost_measured: false }, 2)).toBe('cost unknown');
    expect(formatCostUsd({})).toBe('cost unknown');
    for (const cost_usd of [-1, NaN, Infinity]) {
      expect(measuredCostUsd({ cost_usd })).toBe(0);
      expect(declaredUnknownCostUsd({ cost_usd })).toBe(1);
      expect(formatCostUsd({ cost_usd })).toBe('cost unknown');
    }
    expect(declaredUnknownCostUsd({ cost_measured: true })).toBe(1);
    expect(declaredUnknownCostUsd({})).toBe(0);
  });
});
