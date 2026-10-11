/**
 * Round R4 (helper H73; r20, ledger row 162, finding 6): one count of a workflow run's blocks for every view that counts
 * them: `/jobs` and the Jobs part of `/results`, the Control Room (`/room` and the board's), and `/op` cards. H67 made
 * `/jobs` count against the order the run was to run (src/workflows/run-blocks.ts runBlocks); the Control Room still
 * counted the steps it saw, so after recovery it said "2 of 2 steps" for a run of three blocks (r20). Read here once:
 *
 *   - with the order the run was to run (its record's `expected`, kept from its sealed prediction since H67, or this REPL's
 *     own prediction): "N of M steps", M every block of that order (and any other block the run recorded), N the blocks that
 *     ended (completed, failed, stopped or interrupted), each block with runBlocks' word (a later block "not run" only where
 *     that is known, else "not seen") and its own receipt where the record has one (H74);
 *   - without it (a record written before H67): what was seen, "N steps seen", and that the planned count is not recorded.
 *
 * Nothing here reads a file: the caller gives the record and, where it has them, the order, the clock and the receipts.
 */
import type { JobRecord } from '../jobs/index.js';
import { runBlocks, type RunBlock } from './run-blocks.js';

/** The words of a block that ended (runBlocks' words). */
export const ENDED_WORDS: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped', 'interrupted']);
/** What a run whose record has no planned order says beside what it saw. */
export const NO_PLAN = 'the planned count is not recorded';

export interface BlockCount {
  /** every block, in the order the run was to run them (then any other it recorded); only those seen without an order */
  blocks: RunBlock[];
  /** how many of them ended */
  ended: number;
  /** how many blocks the order holds (and any other the run recorded); absent when no order is recorded */
  of?: number;
  /** "2 of 3 steps", or "2 steps seen (the planned count is not recorded)" */
  words: string;
  /** what stands out after the count, in words: the block running, failed (with its exit), stopped or interrupted, and the
   *  blocks not run or not seen ("" when nothing does) */
  detail: string;
}

type CountRecord = Pick<JobRecord, 'state' | 'stale' | 'interrupted' | 'steps' | 'args'> & Partial<Pick<JobRecord, 'expected'>>;

const names = (list: RunBlock[]): string => (list.length > 3 ? `${list.slice(0, 3).map((b) => b.name).join(', ')} and ${list.length - 3} more` : list.map((b) => b.name).join(', '));

/**
 * A workflow run's blocks counted once. `order`, the order the caller knows (this REPL's own prediction); otherwise the
 * record's own `expected`. `clock` and `receipts` as runBlocks takes them.
 */
export function blockCount(j: CountRecord, o: { order?: readonly string[]; clock?: (i: number) => number | undefined; receipts?: ReadonlyMap<string, { receipt: string }> } = {}): BlockCount {
  const order = o.order?.length ? o.order : j.expected?.steps?.length ? j.expected.steps : undefined;
  const blocks = runBlocks(j, order ?? [], o.clock, o.receipts);
  const ended = blocks.filter((b) => ENDED_WORDS.has(b.word)).length;
  const words = order
    ? `${ended} of ${blocks.length} ${blocks.length === 1 ? 'step' : 'steps'}`
    : `${blocks.length} ${blocks.length === 1 ? 'step' : 'steps'} seen (${NO_PLAN})`;
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.word === 'running') parts.push(`${b.name} running`);
    else if (b.word === 'failed') parts.push(`${b.name} failed${b.code !== undefined ? `, exit ${b.code}` : ''}`);
    else if (b.word === 'stopped' || b.word === 'interrupted') parts.push(`${b.name} ${b.word}`);
  }
  const notRun = blocks.filter((b) => b.word === 'not run');
  const notSeen = blocks.filter((b) => b.word === 'not seen');
  if (notRun.length) parts.push(`${names(notRun)} not run`);
  if (notSeen.length) parts.push(`${names(notSeen)} not seen`);
  return { blocks, ended, ...(order ? { of: blocks.length } : {}), words, detail: parts.join('; ') };
}

/** The count and what stands out, as one line: "2 of 3 steps; second interrupted; third not seen". */
export const blockCountLine = (c: BlockCount): string => (c.detail ? `${c.words}; ${c.detail}` : c.words);
