/**
 * R4 (H109; r25 D9 c, and the operator's direction of 2026-10-11: "Bind workflow/result nodes to real operation and artifact
 * IDs"): a workflow card placed for an operation ("Place this operation") shows that operation's own run of the document,
 * never the newest run in its place (the newest may be another operation's, run since). Read with the same readers the
 * workflow card uses (connectWorkflow, as the board connects a document to its runs; workflowDetail, as the card says a
 * run), given only the job records that name the operation: so its run, and its blocks' states, are exactly what that
 * operation's own records say. Nothing here writes, runs or seals.
 */
import type { JobRecord } from '../jobs/index.js';
import type { ParamsCard } from '../repl/board-cards.js';
import type { WorkflowDocInput } from '../repl/board-nodes.js';
import { connectWorkflow, runOf } from '../repl/board-workflows.js';
import type { Receipt } from '../utils/receipts.js';
import { workflowDetail, type Text, type WorkflowDetail } from './card-detail.js';

/** One operation's run of one workflow document, as its workflow card shows a run. */
export interface OperationRun {
  /** the workflow card's id (workflow:<document>) */
  card: string;
  doc: string;
  /** the newest of its runs of the document (its job record names the operation) */
  last: NonNullable<WorkflowDetail['last']>;
  /** each block of the document as it is now, with the state the operation's own runs left it in */
  blocks: Array<{ name: string; word: string; glyph: string; detail: string }>;
}

/** What reading a document's runs needs, as the workflow cards read them. */
export interface RunsSource {
  root: string;
  /** the project's job records, newest first */
  jobs: readonly JobRecord[];
  chain: readonly Receipt[];
  files: readonly string[];
  scrub: (t: string) => string;
  tray: () => ParamsCard | undefined;
  text: Text;
}

/**
 * At most this many operations are read for their runs in one reading (each is one more connectWorkflow per document it ran
 * whose newest run is another's); the reading says so when there are more.
 */
export const RUNS_OPERATIONS = 60;

/**
 * Operation `op`'s runs of the workflow documents `docs` (each the card's id and the board's view of the document, before it
 * was connected to its runs): one per document it ran, its newest run there; none for a document it did not run.
 */
export function operationRuns(op: string, docs: ReadonlyArray<{ card: string; view: WorkflowDocInput }>, src: RunsSource): OperationRun[] {
  const mine = src.jobs.filter((j) => j.operation === op);
  if (!mine.length) return [];
  const out: OperationRun[] = [];
  for (const { card, view } of docs) {
    if (!mine.some((j) => runOf(j)?.doc === view.rel)) continue;
    const w = connectWorkflow(view, { root: src.root, jobs: mine, chain: src.chain, files: src.files, scrub: src.scrub, tray: src.tray });
    const d = workflowDetail(w, src.text);
    if (!d.last) continue;
    out.push({ card, doc: d.doc, last: d.last, blocks: d.blocks.map((b) => ({ name: b.name, word: b.word, glyph: b.glyph, detail: b.detail })) });
  }
  return out;
}
