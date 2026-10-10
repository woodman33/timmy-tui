/**
 * Round R4 (helper H74; the plan's F-3 and R1 item 5): one receipt per workflow block.
 *
 * As each block of a /run ends, as Timmy reads it (src/workflows/upmd-live.ts on a pty, src/workflows/upmd.ts over a
 * pipe), it is sealed on the runs chain as a `workflow-block` receipt: after the run's prediction and before the run's own
 * receipt, which names its block receipts (each step's `receipt` in its `job.steps`, and `child_receipts` in step order).
 *   - a block that never started gets none;
 *   - a block cut by a stop (/stop, a time limit, a stop by `timmy act` or `timmy md`) gets one whose outcome is
 *     interrupted, `interrupted_by` 'stop' or 'time limit';
 *   - a block cut because the REPL following its run ended gets one from the next REPL's recovery (workflow-recover.ts),
 *     outcome interrupted, `interrupted_by` 'repl ended'; one whose end only the run's pty wrapper saw (its stop file) gets
 *     one with `seen: 'wrapper'`;
 *   - upmd ending while a block it started had not ended (no end line) gives that block outcome 'unknown'.
 *
 * Receipt.block, what a block receipt adds to a receipt (src/utils/receipts.ts):
 *   run, doc, name, index        the run's job id, the document (relative to the project), the block's name as upmd said it
 *                                and upmd's number for it (null when not seen)
 *   code_sha256, code_from       the sha256 of the block's code as /run read it from the document before upmd started, and
 *                                where that came from in words; null when the document has no such block (or, after an
 *                                ended REPL, when the document changed since the run started)
 *   doc_sha256, doc_at_end       the document's sha256 then (its prediction's), and the document checked again when the
 *                                block ended: 'unchanged', 'changed', 'gone' or 'unreadable'. upmd reads the document
 *                                itself and Timmy does not see what it read, so the code hashed is the code run only while
 *                                the document stayed those bytes
 *   state, outcome               the step's state as Timmy read it (completed, failed, stopped, interrupted, running) and
 *                                the block's outcome: completed, failed, interrupted, unknown
 *   interrupted_by, stop_words   what cut it, and the stop's own words when they are known
 *   exit_code                    upmd's word for it ("exited with code N"); null when not seen
 *   started_at, ended_at, ms     when Timmy saw its start and end (a run on a pty only: over a pipe upmd prints both when the
 *                                block ends) and its own time; null when not seen
 *   seen                         'timmy', or 'wrapper' (its end as the run's pty wrapper saw it, its REPL gone)
 *   prediction                   the prediction receipt sealed before the run (its short id), null when there is none
 *   files, files_checked         the files Timmy can prove it changed, and what was checked for them, in words: see
 *                                src/workflows/block-files.ts. A block's own commands are not followed: what they wrote
 *                                themselves is never listed
 *
 * This module only builds and reads: the REPL's sealer is src/repl/workflow-blocks.ts.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { JobStep } from '../jobs/index.js';
import type { Receipt, ReceiptInput } from '../utils/receipts.js';
import type { WorkflowBlock } from './upmd.js';

/** The kind of a block's receipt on the runs chain. */
export const BLOCK_RECEIPT_KIND = 'workflow-block';

export type BlockOutcome = 'completed' | 'failed' | 'interrupted' | 'unknown';
export type BlockCut = 'stop' | 'time limit' | 'repl ended';
export type DocAtEnd = 'unchanged' | 'changed' | 'gone' | 'unreadable';

/** A file a block's receipt names: what a record of one of Timmy's own runs says that run wrote. */
export interface ProvenFile {
  /** relative to the project */
  path: string;
  /** the sha256 the record gives it */
  sha256?: string;
  /** what it is, in a few words (a STEP, the editable source, a run's record) */
  role: string;
  /** the run that wrote it: `flow f1a2b3c4d`, `openscad run 1a2b3c4d`, `agent run a1a2b3c4d` */
  by: string;
  /** the record that names it, relative to the project */
  record: string;
  /** the receipt that sealed that record (its short id), when one on the chain does */
  receipt?: string;
}

/** Receipt.block (see the module comment). */
export interface BlockFacts {
  run: string;
  doc: string;
  name: string;
  index: number | null;
  code_sha256: string | null;
  code_from: string;
  doc_sha256: string | null;
  doc_at_end: DocAtEnd;
  state: string;
  outcome: BlockOutcome;
  interrupted_by?: BlockCut;
  stop_words?: string;
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
  ms: number | null;
  seen: 'timmy' | 'wrapper';
  prediction: string | null;
  files: ProvenFile[];
  /** how many more files were found than `files` names (src/workflows/block-files.ts BLOCK_FILES_MAX) */
  files_more?: number;
  files_checked: string;
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
/** A receipt's short id, as the REPL names receipts (the hash's first 8 hex digits after "sha256_"). */
export const receiptShort = (r: Pick<Receipt, 'hash'>): string => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : '');

/** Where code_sha256 came from, in words. */
export const CODE_FROM = 'the block\'s code in the document as /run read it, before upmd started';
export const CODE_FROM_RECOVERY = 'the block\'s code in the document now, which is the document its prediction sealed';
export const CODE_UNKNOWN_CHANGED = 'not known: the document changed since the run started, and the REPL that read it has ended';
export const CODE_UNKNOWN_MISSING = 'not known: the document as /run read it has no block of this name';

/**
 * The document's block a step ran: by upmd's number when that block carries the step's name (the number counts every
 * fenced block, as parseWorkflow does), else the first block of that name.
 */
export function blockOf(blocks: readonly WorkflowBlock[], step: Pick<JobStep, 'name' | 'index'>): WorkflowBlock | undefined {
  const at = step.index !== undefined ? blocks[step.index - 1] : undefined;
  if (at && at.name === step.name) return at;
  return blocks.find((b) => b.name === step.name);
}

/** The sha256 of a block's code (its lines between its fences, joined with \n, as parseWorkflow reads them). */
export const codeSha256 = (b: Pick<WorkflowBlock, 'code'>): string => sha(b.code);

/** The document checked again: its bytes the sha256 given, other bytes, gone, or not readable (a link, a folder, too large). */
export function docAtEnd(root: string, rel: string, expected: string | undefined, max = 16 * 1024 * 1024): DocAtEnd {
  try {
    const abs = path.join(root, ...rel.split('/'));
    const st = lstatSync(abs);
    if (!st.isFile() || st.size > max) return 'unreadable';
    if (!expected) return 'unreadable';
    return sha(readFileSync(abs)) === expected ? 'unchanged' : 'changed';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable';
  }
}

/** A block's outcome from its step: completed and failed as they ended; stopped and interrupted are interrupted. */
export function outcomeOf(s: Pick<JobStep, 'state'>): BlockOutcome {
  return s.state === 'completed' ? 'completed' : s.state === 'failed' ? 'failed' : s.state === 'stopped' || s.state === 'interrupted' ? 'interrupted' : 'unknown';
}

/** A block's receipt as sealed (see the module comment); `project` and `projectId` are the run's. */
export function blockReceiptInput(f: BlockFacts, o: { label: string; project: string; projectId: string; operation?: string }): ReceiptInput {
  const status = f.outcome === 'completed' ? 'ok' as const : f.outcome === 'failed' ? 'failed' as const : f.outcome === 'interrupted' ? 'cancelled' as const : 'failed' as const;
  return {
    kind: BLOCK_RECEIPT_KIND, subject: `workflow · block · ${o.label} · ${f.name} · ${f.outcome}`, policy: 'human-gated', status,
    project: o.project, project_id: o.projectId, block: f,
    // a receipt sealed outside the run's operation (a later REPL's recovery) still names the run's
    ...(o.operation ? { operation_id: o.operation } : {}),
  };
}

/** A block receipt as the views read it. */
export interface BlockReceipt { receipt: string; name: string; index: number | null; outcome: BlockOutcome; state: string; exit_code: number | null; seen: 'timmy' | 'wrapper'; files: number }

/** Whether a receipt is a block receipt Timmy sealed (its block facts present and of the expected shape). */
export function isBlockReceipt(r: Receipt): r is Receipt & { block: BlockFacts } {
  const b = (r as { block?: unknown }).block as Partial<BlockFacts> | undefined;
  return r.kind === BLOCK_RECEIPT_KIND && !!b && typeof b === 'object' && typeof b.run === 'string' && typeof b.name === 'string';
}

/**
 * The block receipts of one run on a chain, by block name (the newest of a name wins: a run runs each block once, and a
 * recovery seals only a block no receipt of the run names). Each with its short id.
 */
export function blockReceiptsOf(chain: readonly Receipt[], run: string): Map<string, BlockReceipt> {
  const out = new Map<string, BlockReceipt>();
  for (const r of chain) {
    if (!r || !isBlockReceipt(r) || r.block.run !== run) continue;
    const b = r.block;
    out.set(b.name, {
      receipt: receiptShort(r), name: b.name, index: typeof b.index === 'number' ? b.index : null, outcome: b.outcome, state: String(b.state),
      exit_code: typeof b.exit_code === 'number' ? b.exit_code : null, seen: b.seen === 'wrapper' ? 'wrapper' : 'timmy', files: Array.isArray(b.files) ? b.files.length : 0,
    });
  }
  return out;
}

/** A block receipt in the few words every view uses: `block build: receipt 1a2b3c4d`. */
export const blockReceiptWords = (name: string, receipt: string): string => `block ${name}: receipt ${receipt}`;
