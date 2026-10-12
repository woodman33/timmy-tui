/**
 * Round R4 (H99, the review of the H99 work): a /run job's end line, what matters first. A notice may be cut at 80 columns
 * (or wrapped: the REPL's printer's concern), so each line says, in this order: its glyph, its id and its word, the
 * operation it ran in ("operation o…"), then for a run that made no change why that is so in a few words (the last build's
 * state first, then what the block did and what upmd did about its exit), then the details (the document › block, its
 * blocks counted as /jobs counts them, the time, the prediction, its receipt, /op), and last the long words of the flow that
 * made no change.
 *
 * R4 (H99, the review; the lead's decision): a /run that completed with a block that made no change reads "no change" (=),
 * never ✓ completed: nothing was changed by that block, and whether the request is satisfied is not known. A run that
 * stopped at such a block reads "no change" too, and says that upmd counted the block as failed (its exit was not 0), never
 * that the request failed.
 */
import type { JobRecord, JobStep } from '../jobs/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { blockCount, blockCountLine } from '../workflows/block-count.js';

type Line = Segment[];

/** The last build's state, as a no-change block's step keeps it, in a few words. */
export function lastBuildWords(s: Pick<JobStep, 'current' | 'last_build'>): string {
  const st = s.last_build ?? (s.current === true ? 'current' : undefined);
  return st === 'current' ? 'the last build still matches its recorded inputs'
    : st === 'stale' ? 'the last build is stale'
      : st === 'none' ? 'there is no build yet'
        : 'whether the last build still matches is not known';
}

/** "operation o…" right after a job's id and word (two spaces, as every notice puts them), or nothing for a job of none. */
export const opLead = (j: Pick<JobRecord, 'operation'>): string => (j.operation ? `  operation ${j.operation}` : '');
/** What comes between that and the rest of the line: the separator after an operation, else the two spaces after the word. */
export const opJoint = (j: Pick<JobRecord, 'operation'>, sep: string): string => (j.operation ? sep : '  ');
/** The command that shows it, at the end of the line. */
export const opTail = (j: Pick<JobRecord, 'operation'>, sep: string): string => (j.operation ? `${sep}/op ${j.operation}` : '');

export interface EndLineContext {
  glyphs: GlyphSet;
  sep: string;
  /** the order the run was to run (this REPL's prediction, else its record's) */
  order?: readonly string[];
  /** its time, as "4.2 s" */
  seconds: string;
  /** whether its sealed prediction was met (completed runs this REPL predicted) */
  met?: boolean;
}

/** Why a /run made no change, in a few words: the last build's state first, then what its block did and what upmd did. */
export function noChangeReason(job: JobRecord): string | undefined {
  if (job.kind !== 'workflow') return undefined;
  const still = job.steps.filter((s) => s.outcome === 'no change');
  if (!still.length) return undefined;
  const failed = job.steps.filter((s) => s.state === 'failed');
  const stopped = job.state === 'failed' && failed.length > 0 && failed.every((s) => s.outcome === 'no change');
  if (!stopped && job.state !== 'completed') return undefined;
  const first = stopped ? failed[0] : still[0];
  return stopped
    ? `${lastBuildWords(first)}: stopped at ${first.name}, which made no change (upmd counted the block as failed: exit ${first.code ?? '?'})`
    : `${lastBuildWords(first)}: ${still.map((s) => s.name).join(', ')} made no change${still.every((s) => s.current === true) ? ', so the blocks after it ran on that build' : ''}`;
}

/**
 * A /run job's end line when one of its blocks made no change: = no change, its operation, why (the last build's state,
 * and whether the blocks after it ran), then the details, then the flow's own words. Undefined for any other run.
 */
export function noChangeEndLine(job: JobRecord, c: EndLineContext): Line | undefined {
  const reason = noChangeReason(job);
  if (!reason) return undefined;
  const stopped = job.state === 'failed';
  const first = (stopped ? job.steps.find((s) => s.state === 'failed') : job.steps.find((s) => s.outcome === 'no change'))!;
  const count = blockCount(job, { ...(c.order ? { order: c.order } : {}) });
  const details = [
    job.label, blockCountLine(count), c.seconds,
    ...(!stopped && c.met !== undefined ? [c.met ? 'prediction met' : 'prediction missed'] : []),
    ...(job.receipt ? [`receipt ${job.receipt}`] : []),
  ].join(c.sep);
  return [
    { text: '  = ' }, { text: `${job.id} no change`, role: 'strong' },
    { text: opLead(job), role: 'strong' },
    { text: `${opJoint(job, c.sep)}${reason}`, role: 'secondary' },
    { text: `${c.sep}${details}${opTail(job, c.sep)}${first.why ? `${c.sep}${first.name}: ${first.why}` : ''}`, role: 'secondary' },
  ];
}
