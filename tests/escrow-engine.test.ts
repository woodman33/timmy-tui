import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';
import { appendReceipt } from '../src/utils/receipts.js';
import { buildAgentPass } from '../src/utils/agent-pass.js';
import {
  armEscrow, lockEscrow, drawEscrow, judgeEscrow, settleEscrow, cancelEscrow, verifyEscrow
} from '../src/utils/escrow-engine.js';

const hex = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

let dir = '';
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'timmy-escrow-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const mkPass = () => {
  const parent = appendReceipt('runs', { kind: 'run', subject: 'escrow pass parent', policy: 'human-gated', status: 'ok', spans: [], artifacts: [] }, dir).hash;
  return buildAgentPass({ parent_receipt: parent, dir }).pass!;
};

describe('escrow settlement state machine (V-03 rung 2)', { timeout: 30000 }, () => {
  it('arm→lock→draw→judge(proof+QA)→settle refunds ceiling−drawn', () => {
    const a = armEscrow({ plan_hash: hex('plan'), ceiling_usd: 1, qa_threshold: 0.5, dir });
    expect(a.ok).toBe(true);
    const id = a.escrow!.escrow_id;
    expect(lockEscrow(id, dir).ok).toBe(true);
    expect(drawEscrow(id, 0.25, dir).ok).toBe(true);
    expect(drawEscrow(id, 1, dir).error_class).toBe('overspend');
    const j = judgeEscrow(id, { pass: mkPass(), qa_value: 0.9, dir });
    expect(j.ok).toBe(true);
    expect(j.escrow!.state).toBe('judged');
    expect(j.escrow!.merkle_root).toBeTruthy();
    const s = settleEscrow(id, dir);
    expect(s.ok).toBe(true);
    expect(s.escrow!.refund_usd).toBe(0.75);
    expect(verifyEscrow(id, dir)).toEqual({ ok: true });
  });

  it('slashes on QA below threshold; no payout path around the gates', () => {
    const a = armEscrow({ plan_hash: hex('plan2'), ceiling_usd: 1, qa_threshold: 0.5, dir });
    const id = a.escrow!.escrow_id;
    lockEscrow(id, dir);
    const j = judgeEscrow(id, { pass: mkPass(), qa_value: 0.2, dir });
    expect(j.escrow!.state).toBe('slashed');
    expect(settleEscrow(id, dir).ok).toBe(false);
  });

  it('slashes on a broken Merkle proof', () => {
    const a = armEscrow({ plan_hash: hex('plan3'), ceiling_usd: 1, qa_threshold: 0.5, dir });
    const id = a.escrow!.escrow_id;
    lockEscrow(id, dir);
    const tampered = { ...mkPass(), merkle_root: hex('evil') };
    const j = judgeEscrow(id, { pass: tampered, qa_value: 0.9, dir });
    expect(j.escrow!.state).toBe('slashed');
  });

  it('cancel refunds the undrawn ceiling (register V-03 criterion)', () => {
    const a = armEscrow({ plan_hash: hex('plan4'), ceiling_usd: 2, qa_threshold: 0.5, dir });
    const id = a.escrow!.escrow_id;
    lockEscrow(id, dir);
    drawEscrow(id, 0.5, dir);
    const c = cancelEscrow(id, undefined, dir);
    expect(c.ok).toBe(true);
    expect(c.escrow!.refund_usd).toBe(1.5);
    expect(verifyEscrow(id, dir)).toEqual({ ok: true });
  });

  it('illegal transitions fail closed', () => {
    const a = armEscrow({ plan_hash: hex('plan5'), ceiling_usd: 1, qa_threshold: 0.5, dir });
    const id = a.escrow!.escrow_id;
    expect(settleEscrow(id, dir).ok).toBe(false);   // armed, not judged
    expect(drawEscrow(id, 0.1, dir).ok).toBe(false); // draw requires locked
  });
});
