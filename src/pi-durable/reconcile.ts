/**
 * Pi Durable, slice S1 (R4 H118): reconciliation at the worker's start, before anything is scheduled (plan e.3.5), in its
 * minimal form for S1's one effect tool. For each effect whose newest ledger record is `started` (its end was never
 * written: a kill, a crash, a power-off), the tool's reconciler reads back what is there and appends what it observed:
 *
 * - slow_write: the file has the new bytes → `ended` (observed: written); the old bytes → `ended` (observed: not
 *   written); neither → `unknown`, a NEEDS YOU for the operator. Timmy never says "exactly once".
 * - trial_shell: ALWAYS `unknown`, never `ended`: what a command did to its trial copy cannot be read back. The NEEDS
 *   YOU names the command and shows its output so far (kept in its output file through the kill), and says when its
 *   process may still be running.
 * - any other tool: `unknown` (no reconciler).
 *
 * The guard refuses a call whose key is still `started` or `unknown` (guard.ts), so a reconciled write lets the model's
 * repeat through (the compare-and-set then writes nothing: one effect), and an unknown one blocks it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EffectLedger, EffectRecord } from './effects.js';
import { fileSha256, fileTail, writeTarget } from './slow-tools.js';

export interface Reconciled { readonly key: string; readonly run: string; readonly state: 'ended' | 'unknown'; readonly outcome: string }

export function reconcileOpen(ledger: EffectLedger, root: string): Reconciled[] {
  const out: Reconciled[] = [];
  for (const r of ledger.open()) {
    const { state, outcome, readback } = readBack(r, root);
    ledger.append({ key: r.key, run: r.run, tool: r.tool, target: r.target, call_id: r.call_id, task: r.task, args_sha256: r.args_sha256, expected_sha256: r.expected_sha256, new_sha256: r.new_sha256, ...(r.argv ? { argv: r.argv, output: r.output } : {}), state, outcome, readback, by: 'reconcile' });
    out.push({ key: r.key, run: r.run, state, outcome });
  }
  return out;
}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

function readBack(r: EffectRecord, root: string): { state: 'ended' | 'unknown'; outcome: string; readback?: { sha256: string } } {
  if (r.tool === 'trial_shell') {
    const out = r.output ? join(root, r.output) : undefined;
    const tail = out ? fileTail(out, 400) : { text: '', bytes: 0 };
    let pid: number | undefined;
    try { pid = out ? Number.parseInt(readFileSync(`${out}.pid`, 'utf8'), 10) : undefined; } catch { pid = undefined; }
    const running = pid && Number.isInteger(pid) && pid > 1 && pidAlive(pid) ? ` A process with its pid (${pid}) still runs: it may be the command.` : '';
    return {
      state: 'unknown',
      outcome: `trial_shell was interrupted mid-command; what a command did cannot be read back: NEEDS YOU. The command: ${JSON.stringify(r.argv ?? [])}.${running} Its output so far (${tail.bytes} bytes${tail.bytes > 400 ? ', its end' : ''}): ${JSON.stringify(tail.text)}`,
      ...(out ? { readback: { sha256: fileSha256(out) } } : {}),
    };
  }
  if (r.tool !== 'slow_write') return { state: 'unknown', outcome: `no reconciler for ${r.tool}: NEEDS YOU` };
  const t = writeTarget(root, { path: r.target });
  if ('error' in t) return { state: 'unknown', outcome: `the target cannot be read back (${t.error}): NEEDS YOU` };
  const sha = fileSha256(t.path);
  if (sha === r.new_sha256) return { state: 'ended', outcome: 'observed after a restart: the file has the new bytes (the write happened)', readback: { sha256: sha } };
  if (sha === r.expected_sha256) return { state: 'ended', outcome: 'observed after a restart: the file has the old bytes (the write did not happen)', readback: { sha256: sha } };
  return { state: 'unknown', outcome: 'observed after a restart: the file has neither the old nor the new bytes: NEEDS YOU', readback: { sha256: sha } };
}
