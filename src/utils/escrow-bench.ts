// V-03 graduation benchmark (v0.8.0): the register criterion, measured —
// a cancelled run seals a refund receipt equal to ceiling minus drawn, the
// runs chain walks ceiling→draws→refund clean, the full lifecycle settles
// with the same refund invariant, and a tampered Merkle proof slashes with
// no payout path. Every outcome is receiptable by the caller.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';
import { appendReceipt, verifyChain } from './receipts.js';
import { buildAgentPass } from './agent-pass.js';
import {
  armEscrow, lockEscrow, drawEscrow, judgeEscrow, settleEscrow, cancelEscrow, verifyEscrow
} from './escrow-engine.js';

export interface EscrowBenchResult {
  ok: boolean;
  graduated: boolean;
  lifecycle_refund?: number;
  cancel_refund?: number;
  tamper_slashed?: boolean;
  chain_ok?: boolean;
  escrow_ids?: string[];
  note?: string;
}

const hex = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export function runEscrowBench(): EscrowBenchResult {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-escrow-bench-'));
  const mkPass = () => {
    const parent = appendReceipt('runs', { kind: 'run', subject: 'escrow bench parent', policy: 'human-gated', status: 'ok', spans: [], artifacts: [] }, dir).hash;
    return buildAgentPass({ parent_receipt: parent, dir }).pass!;
  };

  // lane 1: arm → lock → draw → judge(proof+QA) → settle; refund = ceiling − drawn
  const a1 = armEscrow({ plan_hash: hex('bench-life'), ceiling_usd: 1, qa_threshold: 0.5, dir });
  if (!a1.ok) return { ok: false, graduated: false, note: a1.note };
  const id1 = a1.escrow!.escrow_id;
  lockEscrow(id1, dir);
  drawEscrow(id1, 0.25, dir);
  const j1 = judgeEscrow(id1, { pass: mkPass(), qa_value: 0.9, dir });
  const s1 = settleEscrow(id1, dir);
  const lifeOk = j1.escrow?.state === 'judged' && s1.escrow?.state === 'settled' && s1.escrow?.refund_usd === 0.75 && verifyEscrow(id1, dir).ok;

  // lane 2 (register criterion): cancel seals refund = ceiling − drawn; chain walks clean
  const a2 = armEscrow({ plan_hash: hex('bench-cancel'), ceiling_usd: 2, qa_threshold: 0.5, dir });
  if (!a2.ok) return { ok: false, graduated: false, note: a2.note };
  const id2 = a2.escrow!.escrow_id;
  lockEscrow(id2, dir);
  drawEscrow(id2, 0.5, dir);
  const c2 = cancelEscrow(id2, undefined, dir);
  const chain = verifyChain('runs', dir);
  const cancelOk = c2.escrow?.refund_usd === 1.5 && verifyEscrow(id2, dir).ok && chain.ok;

  // lane 3: tampered Merkle proof slashes; settle refused
  const a3 = armEscrow({ plan_hash: hex('bench-tamper'), ceiling_usd: 1, qa_threshold: 0.5, dir });
  if (!a3.ok) return { ok: false, graduated: false, note: a3.note };
  const id3 = a3.escrow!.escrow_id;
  lockEscrow(id3, dir);
  const j3 = judgeEscrow(id3, { pass: { ...mkPass(), merkle_root: hex('evil') }, qa_value: 0.9, dir });
  const tamperOk = j3.escrow?.state === 'slashed' && !settleEscrow(id3, dir).ok;

  return {
    ok: true,
    graduated: Boolean(lifeOk && cancelOk && tamperOk),
    lifecycle_refund: s1.escrow?.refund_usd,
    cancel_refund: c2.escrow?.refund_usd,
    tamper_slashed: tamperOk,
    chain_ok: chain.ok,
    escrow_ids: [id1, id2, id3],
    note: lifeOk && cancelOk && tamperOk ? undefined : 'one or more escrow lanes missed the criterion'
  };
}
