/**
 * Round R4 (H60): the decisions waiting on a person (src/room/decisions.ts) as text: `/decisions` in full (the newest
 * DECISIONS_ALL), and the Control Room's part of `/room` (the first DECISIONS_SHOWN). Every string comes from the view,
 * already cleaned and scrubbed; colour only repeats a word (an outcome is never green; the commands are the strong lines).
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { NOTHING_DONE, type Decision, type DecisionKind, type DecisionsView } from './decisions.js';

type Line = Segment[];

export interface DecisionTextOptions {
  glyphs: GlyphSet;
  /** a project path as the terminal shows it (an OSC 8 link where it can); plain text by default */
  link?: (rel: string) => string;
}

/** What kind of wait an item is, in a few words after its title. */
export const KIND_WORDS: Readonly<Record<DecisionKind, string>> = {
  approval: 'blocks a running request', 'stale-save': 'blocks a requested save', left: 'left by a session that ended',
  setup: 'setup a run needs', interrupted: 'interrupted', differs: 'differs', failed: 'failed', lesson: 'memory',
};

/** One item: its title and kind, what is needed, why, its record, the keys or steps, the commands, and the closing line. */
export function decisionLines(d: Decision, o: DecisionTextOptions, indent = '    '): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const link = o.link ?? ((rel: string) => rel);
  const label = (t: string): Segment => ({ text: `${indent}  ${t.padEnd(8)}`, role: 'secondary' });
  const lines: Line[] = [
    [{ text: `${indent}! `, role: 'estimate' }, { text: d.title, role: 'strong' }, { text: `  ${d.kindWords ?? KIND_WORDS[d.kind]}`, role: d.blocks ? 'estimate' : 'secondary' }],
    [label('needed'), { text: d.needed }],
    [label('why'), { text: d.why, role: 'secondary' }],
  ];
  if (d.record) lines.push([label('record'), { text: link(d.record) }, { text: d.receipt ? `${sep}receipt ${d.receipt}` : '', role: 'secondary' }]);
  if (d.keys?.length) lines.push([label('keys'), { text: d.keys.join(sep) }]);
  for (const s of d.steps ?? []) lines.push([label('step'), { text: s }]);
  if (d.commands.length) lines.push([label('type'), { text: d.commands.join(sep), role: 'strong' }]);
  lines.push([{ text: `${indent}  ` }, { text: NOTHING_DONE, role: 'secondary' }]);
  return lines;
}

/** The lines after the items: what was not shown, the other setup rows, the tools check, and the notes. */
function tailLines(v: DecisionsView, o: DecisionTextOptions, more: string, indent: string): Line[] {
  const lines: Line[] = [];
  if (v.more) lines.push([{ text: `${indent}and ${v.more} more ${v.more === 1 ? 'waits' : 'wait'}: ${more}`, role: 'secondary' }]);
  if (v.otherSetup) lines.push([{ text: `${indent}${v.otherSetup} other ${v.otherSetup === 1 ? 'row' : 'rows'} of /tools ${v.otherSetup === 1 ? 'needs' : 'need'} setup for a tool no run of this project used or tried: /tools lists ${v.otherSetup === 1 ? 'it' : 'them'}`, role: 'secondary' }]);
  if (v.tools.note) lines.push([{ text: `${indent}Setup: ${v.tools.note}`, role: 'secondary' }]);
  for (const n of v.notes) lines.push([{ text: `${indent}${n}`, role: 'estimate' }]);
  return lines;
}

/** What "nothing waits" covers, in words. */
export const NOTHING = 'no NEEDS YOU box, refused save, run left by a session that ended, setup a run needs, run that ended needing you, or lesson to check';

/** `/decisions`: everything waiting on a person in the project (the newest DECISIONS_ALL), what blocks first. */
export function decisionsLines(v: DecisionsView, o: DecisionTextOptions & { project: string }): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const head: Line = v.total
    ? [{ text: '  Waiting on you  ', role: 'strong' }, { text: `${v.total} in ${o.project}`, role: 'strong' }, { text: `${sep}what blocks a request first${sep}from the records and checks each names`, role: 'secondary' }]
    : [{ text: '  Waiting on you  ', role: 'strong' }, { text: `nothing in ${o.project}: ${NOTHING}`, role: 'secondary' }];
  const lines: Line[] = [head];
  for (const d of v.items) lines.push(...decisionLines(d, o));
  lines.push(...tailLines(v, o, `only the first ${v.items.length} are shown here`, '    '));
  lines.push([{ text: `  The Control Room shows the first of these: /room${sep}on the board: /board live`, role: 'secondary' }]);
  return lines;
}

/** The Control Room's part of `/room`: the first items, and how to see the rest. */
export function roomDecisionLines(v: DecisionsView, o: DecisionTextOptions): Line[] {
  const lines: Line[] = [[{ text: '  WAITING ON YOU', role: 'strong' }, { text: v.total ? `  ${v.total}, what blocks a request first; all of them: /decisions` : '', role: 'secondary' }]];
  if (!v.total) lines.push([{ text: `    Nothing: ${NOTHING}.`, role: 'secondary' }]);
  for (const d of v.items) lines.push(...decisionLines(d, o));
  lines.push(...tailLines(v, o, '/decisions lists them', '    '));
  return lines;
}
