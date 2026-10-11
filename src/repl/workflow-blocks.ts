/**
 * Round R4 (helper H74): the REPL's sealer of a /run's block receipts (src/workflows/block-receipts.ts says what each one
 * holds). The Workspace begins following a run when it starts it (begin), tells the sealer of every change of the run's
 * job (note), and, as the run's own receipt is sealed, asks it for the blocks not sealed yet, sealed first, and every
 * block's receipt in step order (finish). `timmy act` and `timmy md` run the same Workspace, so their runs are sealed alike.
 *
 * A step is sealed once it is final: completed, or failed with its exit code. upmd may say a block failed (its chain line,
 * on stderr) before its end line gives the code (stdout, read in no fixed order): such a step waits for its code until the
 * run ends. When the run ends, a failed step still without its code is sealed with none; a step stopped, or still running,
 * is sealed as cut by the stop that ended the run (/stop, a time limit, a stop by `timmy act`, `timmy md` or the REPL's
 * end, with the stop's own words when the Workspace has them); and a step still running when upmd ended by itself, without
 * saying how the block ended, is sealed with outcome unknown.
 *
 * A run whose REPL ended is not followed by any sealer: the next REPL's recovery (src/repl/workflow-recover.ts) seals what
 * its record then says (sealLeftBlocks), each block no receipt of the run names yet.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { JobRecord, JobStep } from '../jobs/index.js';
import type { Receipt, ReceiptInput } from '../utils/receipts.js';
import { provenFiles, type BlockWindow } from '../workflows/block-files.js';
import {
  blockOf, blockReceiptInput, blockReceiptsOf, CODE_FROM, CODE_FROM_RECOVERY, CODE_UNKNOWN_CHANGED, CODE_UNKNOWN_MISSING, codeSha256, docAtEnd,
  outcomeOf, receiptShort, type BlockCut, type BlockFacts, type BlockOutcome,
} from '../workflows/block-receipts.js';
import { stepMs } from '../workflows/run-blocks.js';
import { parseWorkflow, type WorkflowBlock } from '../workflows/upmd.js';
import { runOf } from './board-workflows.js';

/** A run the sealer follows: what /run read before upmd started. */
export interface BlockRun {
  root: string;
  project: string;
  projectId: string;
  /** the document, relative to the project */
  doc: string;
  /** its sha256 as /run read it (the prediction's) */
  docSha256?: string;
  /** its blocks as /run read them */
  blocks: readonly WorkflowBlock[];
  /** the prediction receipt sealed before the run (short id) */
  prediction?: string;
}

/** A step of a run and its block's receipt (absent when none was sealed: a seal that failed). */
export interface SealedBlock { step: number; name: string; receipt?: string }

export interface BlockSealerDeps {
  seal: (input: ReceiptInput) => string | undefined;
  /** the runs chain now (for the receipts that sealed the records a block's files come from) */
  chain: () => readonly Receipt[];
  /** the project's folder written as "." and the home folder as "~" */
  scrub: (text: string, root: string) => string;
  now?: () => number;
}

interface Followed { run: BlockRun; sealed: Map<number, string | null>; ends: Map<number, number> }

/** A step ready for its receipt while the run goes on: completed, or failed with its exit code. */
const final = (s: JobStep): boolean => s.state === 'completed' || (s.state === 'failed' && s.code !== undefined);
const TIME_LIMIT = /\btimed out\b/;

export class BlockSealer {
  private readonly runs = new Map<string, Followed>();
  /** the receipts of the runs that ended, newest last (at most 64 runs), for the notices said after a run's end */
  private readonly ended = new Map<string, Map<number, string | null>>();
  constructor(private readonly d: BlockSealerDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** A run to follow from its start: its blocks are sealed as they end. */
  begin(job: string, run: BlockRun): void { this.runs.set(job, { run, sealed: new Map(), ends: new Map() }); }

  /** Whether this sealer follows the job (a run this REPL started that has not ended). */
  follows(job: string): boolean { return this.runs.has(job); }

  /** The receipt (short id) this sealer sealed for a step of a run, by the step's position in its job's steps. */
  receiptOf(job: string, step: number): string | undefined {
    return (this.runs.get(job)?.sealed ?? this.ended.get(job))?.get(step) ?? undefined;
  }

  /** The run's job changed: each block that has ended since is sealed. */
  note(job: JobRecord): void {
    const f = this.runs.get(job.id);
    if (!f) return;
    const now = this.now();
    job.steps.forEach((s, i) => {
      if (s.state !== 'running' && !f.ends.has(i)) f.ends.set(i, now);
      if (!f.sealed.has(i) && final(s)) this.seal(job, f, i, s, {});
    });
  }

  /**
   * The run has ended (its own receipt is being sealed): every step not sealed yet is sealed now (see the module comment),
   * and every step's receipt is given back in step order. `stop`: the words of the stop that ended it, when known.
   */
  finish(job: JobRecord, o: { stop?: string } = {}): SealedBlock[] {
    const f = this.runs.get(job.id);
    if (!f) return [];
    const now = this.now();
    const stopped = job.state === 'cancelled' || (job.state === 'failed' && TIME_LIMIT.test(job.error ?? ''));
    const cut: BlockCut = job.state === 'failed' && TIME_LIMIT.test(job.error ?? '') ? 'time limit' : 'stop';
    job.steps.forEach((s, i) => {
      if (s.state !== 'running' && !f.ends.has(i)) f.ends.set(i, now);
      if (f.sealed.has(i)) return;
      if (s.state === 'completed' || s.state === 'failed') this.seal(job, f, i, s, {});
      else if (s.state === 'stopped' || s.state === 'interrupted' || stopped) this.seal(job, f, i, s, { outcome: 'interrupted', cut, ...(o.stop ? { stop: o.stop } : {}) });
      else this.seal(job, f, i, s, { outcome: 'unknown' });
    });
    this.runs.delete(job.id);
    this.ended.set(job.id, f.sealed);
    if (this.ended.size > 64) this.ended.delete(this.ended.keys().next().value!);
    return job.steps.map((s, i) => ({ step: i, name: s.name, ...(f.sealed.get(i) ? { receipt: f.sealed.get(i)! } : {}) }));
  }

  private seal(job: JobRecord, f: Followed, i: number, s: JobStep, o: { outcome?: BlockOutcome; cut?: BlockCut; stop?: string }): void {
    f.sealed.set(i, null); // tried once: a seal that fails is not tried again
    const run = f.run;
    const block = blockOf(run.blocks, s);
    const end = s.endedAt ? Date.parse(s.endedAt) : f.ends.get(i) ?? this.now();
    const before = i > 0 ? job.steps[i - 1] : undefined;
    const from = before ? (before.endedAt ? Date.parse(before.endedAt) : f.ends.get(i - 1)) : undefined;
    const window: BlockWindow = { from: Number.isFinite(from) ? from! : Date.parse(job.startedAt), to: end };
    let found: ReturnType<typeof provenFiles>;
    try { found = provenFiles(run.root, job.operation, window, this.d.chain()); } catch { found = { files: [], more: 0, checked: 'the records of Timmy\'s own runs could not be read' }; }
    const outcome = o.outcome ?? outcomeOf(s);
    const facts: BlockFacts = {
      run: job.id, doc: run.doc, name: s.name, index: s.index ?? block?.index ?? null,
      code_sha256: block ? codeSha256(block) : null, code_from: block ? CODE_FROM : CODE_UNKNOWN_MISSING,
      doc_sha256: run.docSha256 ?? null, doc_at_end: docAtEnd(run.root, run.doc, run.docSha256),
      state: s.state, outcome,
      ...(outcome === 'interrupted' ? { interrupted_by: o.cut ?? 'stop', ...(o.stop ? { stop_words: this.d.scrub(o.stop, run.root).slice(0, 200) } : {}) } : {}),
      exit_code: s.code ?? null,
      started_at: s.startedAt ?? null,
      // when Timmy saw its end (a pty run stamps it; over a pipe, when upmd's lines for it came); a block cut while it ran:
      // when its run ended
      ended_at: s.endedAt ?? (s.state === 'running' ? job.endedAt ?? null : new Date(end).toISOString()),
      ms: stepMs(s) ?? null,
      seen: s.seen === 'wrapper' ? 'wrapper' : 'timmy',
      prediction: run.prediction ?? null,
      files: found.files.map((x) => ({ ...x, path: this.d.scrub(x.path, run.root) })), ...(found.more ? { files_more: found.more } : {}), files_checked: found.checked,
    };
    let id: string | undefined;
    try { id = this.d.seal(blockReceiptInput(facts, { label: this.d.scrub(job.label, run.root), project: run.project, projectId: run.projectId })); } catch { id = undefined; }
    if (id) f.sealed.set(i, id);
  }
}

// ── a run whose REPL ended: sealed by the next REPL's recovery ───────────────

export interface LeftBlocksDeps {
  seal: (input: ReceiptInput) => string | undefined;
  chain: () => readonly Receipt[];
  scrub: (text: string) => string;
  project: string;
  projectId: string;
  now?: () => number;
}

/** The document a run read and its blocks, read again now, when it is still the bytes its prediction sealed. */
function docThen(job: JobRecord, chain: readonly Receipt[]): { doc?: string; docSha256?: string; blocks?: WorkflowBlock[]; changed?: boolean } {
  const r = runOf(job);
  if (!r) return {};
  const pred = job.expected?.receipt ? chain.find((x) => x.kind === 'predict' && receiptShort(x) === job.expected!.receipt) : undefined;
  const docSha256 = pred?.files?.find((f) => f.path === r.doc)?.sha256;
  const file = job.args.at(-1);
  if (!docSha256 || !file || !isAbsolute(file)) return { doc: r.doc, ...(docSha256 ? { docSha256 } : {}) };
  try {
    if (statSync(file).size > 1024 * 1024) return { doc: r.doc, docSha256 };
    const bytes = readFileSync(file);
    const now = docAtEnd(job.root, r.doc, docSha256);
    if (now !== 'unchanged') return { doc: r.doc, docSha256, changed: true };
    return { doc: r.doc, docSha256, blocks: parseWorkflow(bytes.toString('utf8')) };
  } catch { return { doc: r.doc, docSha256 }; }
}

/**
 * The block receipts a run whose REPL ended still needs, sealed by recovery from its job record as recovery wrote it: each
 * step that ended (seen by its pty wrapper) or was interrupted, that no block receipt of the run names yet (the REPL may
 * have sealed some before it ended). Each names the run's operation. A step still running in the record (recovery could
 * not end it) and a block that never started get none. Returns the receipts sealed, in step order.
 */
export function sealLeftBlocks(d: LeftBlocksDeps, job: JobRecord): Array<{ name: string; receipt: string }> {
  let chain: readonly Receipt[] = [];
  try { chain = d.chain(); } catch { chain = []; }
  const have = blockReceiptsOf(chain, job.id);
  const then = docThen(job, chain);
  const doc = then.doc ?? job.label;
  const now = (d.now ?? Date.now)();
  const out: Array<{ name: string; receipt: string }> = [];
  job.steps.forEach((s, i) => {
    if (s.state === 'running' || have.has(s.name)) return;
    const block = then.blocks ? blockOf(then.blocks, s) : undefined;
    const before = i > 0 ? job.steps[i - 1] : undefined;
    const fromAt = before?.endedAt ? Date.parse(before.endedAt) : Date.parse(job.startedAt);
    const toAt = s.endedAt ? Date.parse(s.endedAt) : job.interrupted?.wrapper?.at ? Date.parse(job.interrupted.wrapper.at) : now;
    let found: ReturnType<typeof provenFiles>;
    try { found = provenFiles(job.root, job.operation, { from: fromAt, to: Number.isFinite(toAt) ? toAt : now }, chain); } catch { found = { files: [], more: 0, checked: 'the records of Timmy\'s own runs could not be read' }; }
    const outcome = outcomeOf(s);
    const facts: BlockFacts = {
      run: job.id, doc, name: s.name, index: s.index ?? block?.index ?? null,
      code_sha256: block ? codeSha256(block) : null,
      code_from: block ? CODE_FROM_RECOVERY : then.changed ? CODE_UNKNOWN_CHANGED : CODE_UNKNOWN_MISSING,
      doc_sha256: then.docSha256 ?? null,
      doc_at_end: then.doc && then.docSha256 ? docAtEnd(job.root, then.doc, then.docSha256) : 'unreadable',
      state: s.state, outcome,
      ...(outcome === 'interrupted' ? { interrupted_by: 'repl ended' as const } : {}),
      exit_code: s.code ?? null, started_at: s.startedAt ?? null, ended_at: s.endedAt ?? null, ms: stepMs(s) ?? null,
      seen: s.seen === 'wrapper' ? 'wrapper' : 'timmy',
      prediction: job.expected?.receipt ?? null,
      files: found.files.map((x) => ({ ...x, path: d.scrub(x.path) })), ...(found.more ? { files_more: found.more } : {}), files_checked: found.checked,
    };
    let id: string | undefined;
    try { id = d.seal(blockReceiptInput(facts, { label: d.scrub(job.label), project: d.project, projectId: d.projectId, ...(job.operation ? { operation: job.operation } : {}) })); } catch { id = undefined; }
    if (id) out.push({ name: s.name, receipt: id });
  });
  return out;
}
