/**
 * R7 (H152; the R6 interaction review's N5 and the R5 visual review's 6 and 14: a chat turn said "cancelled" on some surfaces,
 * and a stopped turn's receipt showed without "stopped"): the run detail the companion's Workflows tab draws (and the
 * Workbench's tab 3 reads) names each receipt in the one table's words (src/contracts/stop-words.ts receiptSubjectWords): a
 * stopped chat turn's sealed "cancelled" is said "stopped (asked from …)", with who asked; a workflow job's "cancelled" stays
 * as sealed, its own word. The receipts themselves are never changed.
 *
 * Real: the run-detail producer and inspector (src/ops/run-detail.ts), the receipt chain (appendReceipt, on the per-test store
 * TIMMY_STORE, which the producer reads as `timmy act` seals it), the operation
 * record's writer. FIXTURE: an operation record and its two receipts (a REPL turn stopped from the companion; a workflow job
 * cancelled), written here; no model was asked and no job ran.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPERATION_SCHEMA, writeOperationRecord } from '../src/ops/operations.js';
import { readRunInspection, runDetail } from '../src/ops/run-detail.js';
import { folderProject, projectId } from '../src/project/index.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('a run detail\'s receipts in the stop words (R7 H152)', () => {
  it('a stopped chat turn\'s receipt is said stopped, with who asked; a cancelled job\'s stays cancelled; the chain is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-stop-words-'));
    dirs.push(root);
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    const op = 'o5709a7e1';
    const now = new Date().toISOString();
    const w = writeOperationRecord(root, {
      schema: OPERATION_SCHEMA, id: op, request: 'FIXTURE: a chat turn and a job (tests/companion-run-stop-words.test.ts)', via: 'repl', project: folderProject(root).name,
      started: now, ended: now, state: 'stopped', why: 'FIXTURE', parent: null, runs: [], owner: { pid: process.pid, started: now },
    });
    expect(w.ok).toBe(true);
    const pid = projectId(root);
    appendReceipt('runs', { kind: 'turn', subject: 'repl · cancelled · 1 step', policy: 'human-gated', status: 'cancelled', cancelled_at: 'before-tools', stopped_by: 'companion', operation_id: op, project_id: pid } as never);
    appendReceipt('runs', { kind: 'workflow', subject: 'workflow · FIXTURE.md › wait · cancelled', policy: 'human-gated', status: 'cancelled', operation_id: op, project_id: pid } as never);
    const before = JSON.stringify(readChain('runs').map((r) => r.subject));

    const detail = runDetail(op, { project: root });
    expect(detail.receipts.map((r) => r.subject)).toEqual(['repl · stopped (asked from the companion) · 1 step', 'workflow · FIXTURE.md › wait · cancelled']);
    const ins = readRunInspection(op, { project: root });
    expect(ins.ok).toBe(true);
    if (!ins.ok) return;
    expect(ins.inspection.receipts.list.map((r) => r.subject)).toEqual(['repl · stopped (asked from the companion) · 1 step', 'workflow · FIXTURE.md › wait · cancelled']);
    // the receipts as sealed: their subjects keep the words they were sealed with
    expect(JSON.stringify(readChain('runs').map((r) => r.subject))).toBe(before);
    expect(readChain('runs').map((r) => r.subject)).toContain('repl · cancelled · 1 step');
  });
});
