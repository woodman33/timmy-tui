import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { subscribe, publish, type BusEvent } from '../src/bus/index.js';
import { appendReceipt } from '../src/utils/receipts.js';

describe('bus (control-plane-k3e7): runs.jsonl as the event stream', () => {
  it('subscriber sees a seal within 200ms of publish (bus latency budget)', async () => {
    const dir = mkdtempSync(join0());
    try {
      const seen: BusEvent[] = [];
      const h = subscribe(ev => seen.push(ev), { filter: ev => ev.kind === 'receipt.sealed', dir });
      const t0 = Date.now();
      publish('receipt.sealed', { stream: 'runs', hash: 'sha256_' + 'a'.repeat(56), subject: 'bus latency probe' }, dir);
      await waitFor(() => seen.length > 0, 200);
      const dt = Date.now() - t0;
      h.stop();
      expect(seen[0].kind).toBe('receipt.sealed');
      expect(dt).toBeLessThanOrEqual(200); // bus delivery budget (appendReceipt's env-lock is outside it)
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a real appendReceipt seal reaches subscribers', async () => {
    const dir = mkdtempSync(join0());
    try {
      const seen: BusEvent[] = [];
      const h = subscribe(ev => seen.push(ev), { filter: ev => ev.kind === 'receipt.sealed', dir });
      appendReceipt('runs', { kind: 'run', subject: 'bus seal flow', policy: 'auto', spans: [], artifacts: [] }, dir);
      await waitFor(() => seen.length > 0, 2000);
      h.stop();
      expect(seen.length).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('publish appends a non-receipt event that readChain ignores', async () => {
    const dir = mkdtempSync(join0());
    try {
      publish('drop.intake', { lane: 'observer', path: '/tmp/x.png' }, dir);
      const { readChain } = await import('../src/utils/receipts.js');
      expect(readChain('runs', dir).length).toBe(0); // event has no top-level hash
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

function join0(): string { return tmpdir(); }
function waitFor(cond: () => boolean, ms: number): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
    }, 10);
  });
}
