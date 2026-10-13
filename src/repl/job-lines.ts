/**
 * Round R4 (helper H73): a job's line in `/jobs` and in the Jobs part of `/results`, and its judgement in `/jobs <id>`, with
 * the mark Timmy judged (src/room/judge.ts), never the process's exit where a record judged the job: on the Mac (u23, ledger
 * row 166) `/jobs` said "✓ j437b34 completed" for an /unreal run judged failed. A workflow run counts its blocks once, as
 * every view counts them (src/workflows/block-count.ts): "2 of 3 steps", or what was seen when no planned order is recorded.
 *
 * The first line stays plain words: the mark, the id, the outcome word, the label, the judge's own words (cut), the time,
 * the receipt. `/jobs <id>` adds the judge, its record and the job's own end (technical detail, one line).
 */
import type { JobRecord } from '../jobs/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { judgedWords, markGlyph, type JobJudgement } from '../room/judge.js';
import type { BlockCount } from '../workflows/block-count.js';

type Line = Segment[];

/** How long the judge's words may be on a job's one line (the whole of them: `/jobs <id>`). */
const LINE_WHY_MAX = 100;
const cut = (t: string, max: number): string => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

export interface JobLineOptions {
  glyphs: GlyphSet;
  sep: string;
  /** how long it ran (or has run) */
  seconds: string;
  judged: JobJudgement;
  /** a workflow run's blocks, counted once */
  count?: BlockCount;
  /** the words after its time: from an earlier session, interrupted, its note (as the REPL has always said them) */
  after?: string;
}

/** One job, one line: what Timmy judged (✓ only for a judged success), its label, the judge's words, its time and receipt. */
export function jobLineOf(j: JobRecord, o: JobLineOptions): Line {
  const r = o.judged;
  const steps = o.count ? `${o.sep}${o.count.words}` : '';
  const where = j.url && j.state === 'ready' ? `${o.sep}${j.url}` : '';
  const said = judgedWords(r);
  return [
    { text: `  ${markGlyph(r.mark, o.glyphs)} `, role: r.mark === 'failed' ? 'failure' : r.mark === 'unknown' ? 'estimate' : undefined },
    { text: j.id, role: 'strong' },
    { text: `  ${r.word.padEnd(9)} ${j.label}${steps}${said ? `${o.sep}${cut(said, LINE_WHY_MAX)}` : ''}${where}${o.sep}${o.seconds}${j.receipt ? `${o.sep}receipt ${j.receipt}` : ''}${o.after ?? ''}`, role: 'secondary' },
  ];
}

/** `/jobs <id>`: who judged the job, in full, its record and the job's own end; nothing for a job its own exit judges. */
export function judgedLines(r: JobJudgement, o: { sep: string }): Line[] {
  if (r.by !== 'record') return [];
  return [[
    { text: '  Judged   ', role: 'secondary' },
    { text: `${r.word}`, role: r.mark === 'failed' ? 'failure' : r.mark === 'unknown' ? 'estimate' : 'strong' },
    { text: `  ${r.missing ? r.why ?? '' : `by ${r.judge ?? 'its record'}${r.record ? ` (${r.record})` : ''}${r.why ? `: ${r.why}` : ''}`}${r.exit ? `${o.sep}${r.exit}` : ''}`, role: 'secondary' },
  ]];
}
