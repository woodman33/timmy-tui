import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { statusColor, contractViolations, captureViolations, type Fixture } from '../src/tui/color-contract.js';

const FIXTURES: Fixture[] = [
  { name: 'verified-chain', rows: [{ status: 'ok', tab: 'CHAIN' }, { status: 'verified', tab: 'CHAIN' }, { status: 'connected', tab: 'LIBRARY' }] },
  { name: 'refused-receipt', rows: [{ status: 'refused', tab: 'CHAIN' }, { status: 'tamper', tab: 'RUN' }] },
  { name: 'running-lane', rows: [{ status: 'running', tab: 'RUN' }, { status: 'queued', tab: 'RUN' }] },
  { name: 'docker-off', rows: [{ status: 'off', tab: 'HOME' }, { status: 'not_configured', tab: 'LIBRARY' }] },
  { name: 'missing-key', rows: [{ status: 'not_configured', tab: 'LIBRARY' }] },
  { name: 'unverified-receipt', rows: [{ status: 'unverified', tab: 'CHAIN' }] },
  { name: 'insert-mode', rows: [{ status: 'insert', tab: 'HOME' }] },
  // FIX C addendum (director): HOME orange count is exact.
  { name: 'home-all-clear', expectOrange: 0, rows: [
    { status: 'ok', tab: 'HOME' }, { status: 'sealed', tab: 'HOME' }, { status: 'verified', tab: 'HOME' },
    { status: 'connected', tab: 'HOME' }, { status: 'live', tab: 'HOME' }, { status: 'off', tab: 'HOME' } ] },
  { name: 'home-next-step', expectOrange: 1, rows: [
    { status: 'next', tab: 'HOME' }, { status: 'ok', tab: 'HOME' }, { status: 'unverified', tab: 'HOME' }, { status: 'off', tab: 'HOME' } ] },
  { name: 'home-escrow-pending', expectOrange: 1, rows: [
    { status: 'needs-you', tab: 'HOME' }, { status: 'unverified', tab: 'HOME' }, { status: 'ok', tab: 'HOME' }, { status: 'off', tab: 'HOME' } ] },
];

describe('tui.color-contract gate (spec §08, roster kind=count)', () => {
  it('status→token mapping honors the contract', () => {
    expect(statusColor('ok')).toBe('seal');
    expect(statusColor('verified')).toBe('seal');
    expect(statusColor('running')).toBe('warn');
    expect(statusColor('refused')).toBe('danger');
    expect(statusColor('off')).toBe('dim');
    expect(statusColor('not_configured')).toBe('dim');
    expect(statusColor('unverified')).toBe('dim');
  });
  it('fixtures produce zero violations', () => {
    for (const fx of FIXTURES) expect(contractViolations(fx), fx.name).toEqual([]);
  });
  it('FIX C: two orange elements on HOME violate the exact-count rule', () => {
    const v = contractViolations({ name: 'home-two-orange', expectOrange: 1, rows: [
      { status: 'needs-you', tab: 'HOME' }, { status: 'next', tab: 'HOME' } ] });
    expect(v.length).toBeGreaterThan(0);
  });
  it('FIX C: all-clear HOME with a stray orange violates expectOrange 0', () => {
    const v = contractViolations({ name: 'home-clear-but-orange', expectOrange: 0, rows: [
      { status: 'ok', tab: 'HOME' }, { status: 'next', tab: 'HOME' } ] });
    expect(v.length).toBeGreaterThan(0);
  });
  it('NEGATIVE CONTROL: pre-hotfix /tmp/audit/view4.txt must FAIL the contract', () => {
    const p = '/tmp/audit/view4.txt';
    if (!existsSync(p)) return; // control artifact absent in clean CI
    const v = captureViolations(readFileSync(p, 'utf8'));
    expect(v.length).toBeGreaterThan(0);
  });
  it('a clean capture passes', () => {
    expect(captureViolations('OK rc_1 seal x\nVERIFIED chain ok · 724\n○ docker off')).toEqual([]);
  });
});
