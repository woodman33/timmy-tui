/**
 * Pi Durable, slice S1 (R4 H118): reconciliation at the worker's start, before anything is scheduled (plan e.3.5), in its
 * minimal form for S1's one effect tool. For each effect whose newest ledger record is `started` (its end was never
 * written: a kill, a crash, a power-off), the tool's reconciler reads back what is there and appends what it observed:
 *
 * - slow_write: the file has the new bytes → `ended` (observed: written); the old bytes → `ended` (observed: not
 *   written); neither → `unknown`, a NEEDS YOU for the operator. Timmy never says "exactly once".
 * - any other tool: `unknown` (no reconciler).
 *
 * The guard refuses a call whose key is still `started` or `unknown` (guard.ts), so a reconciled write lets the model's
 * repeat through (the compare-and-set then writes nothing: one effect), and an unknown one blocks it.
 */
import type { EffectLedger, EffectRecord } from './effects.js';
import { fileSha256, writeTarget } from './slow-tools.js';

export interface Reconciled { readonly key: string; readonly run: string; readonly state: 'ended' | 'unknown'; readonly outcome: string }

export function reconcileOpen(ledger: EffectLedger, root: string): Reconciled[] {
  const out: Reconciled[] = [];
  for (const r of ledger.open()) {
    const { state, outcome, readback } = readBack(r, root);
    ledger.append({ key: r.key, run: r.run, tool: r.tool, target: r.target, call_id: r.call_id, task: r.task, args_sha256: r.args_sha256, expected_sha256: r.expected_sha256, new_sha256: r.new_sha256, state, outcome, readback, by: 'reconcile' });
    out.push({ key: r.key, run: r.run, state, outcome });
  }
  return out;
}

function readBack(r: EffectRecord, root: string): { state: 'ended' | 'unknown'; outcome: string; readback?: { sha256: string } } {
  if (r.tool !== 'slow_write') return { state: 'unknown', outcome: `no reconciler for ${r.tool}: NEEDS YOU` };
  const t = writeTarget(root, { path: r.target });
  if ('error' in t) return { state: 'unknown', outcome: `the target cannot be read back (${t.error}): NEEDS YOU` };
  const sha = fileSha256(t.path);
  if (sha === r.new_sha256) return { state: 'ended', outcome: 'observed after a restart: the file has the new bytes (the write happened)', readback: { sha256: sha } };
  if (sha === r.expected_sha256) return { state: 'ended', outcome: 'observed after a restart: the file has the old bytes (the write did not happen)', readback: { sha256: sha } };
  return { state: 'unknown', outcome: 'observed after a restart: the file has neither the old nor the new bytes: NEEDS YOU', readback: { sha256: sha } };
}
