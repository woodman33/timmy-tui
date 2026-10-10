/**
 * Round R4 (H65): `/review [<operation id>]` and `/restore`'s answer in the REPL. Every string comes from src/review/changes.ts
 * and goes through `visible` (a control character in a file's name or line shows as its code and moves nothing). Outcome words
 * are in the text colour; a check that is not verified, or a file changed since, carries the attention colour; the commands
 * are strong; a diff's lines use the transcript's own diff colours, and their + and − say the same.
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Role, Segment } from '../term/theme.js';
import type { CardCheck } from '../ops/card.js';
import { moreWords, short, visible, type ReviewChange, type ReviewOperation, type ReviewView } from './changes.js';
import type { Restored } from './restore.js';

type Line = Segment[];
const PAD = '             ';
const stamp = (iso: string | undefined): string => (iso && !Number.isNaN(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time');
const CHECK_ROLE: Readonly<Record<CardCheck['status'], Role | undefined>> = { verified: 'secondary', stale: 'estimate', unverified: 'estimate', missing: 'failure' };
const NOW_ROLE: Readonly<Record<ReviewChange['now']['state'], Role | undefined>> = {
  'unchanged': 'secondary', 'still deleted': 'secondary', 'changed since': 'estimate', 'back': 'estimate', 'gone': 'failure', 'not comparable': 'estimate',
};
/** sha256 before and after, in words where the file was not there or a sha256 is not recorded. */
export function shaWords(c: Pick<ReviewChange, 'before' | 'after' | 'how'>, arrow: string): string {
  const a = c.after === null ? 'deleted' : c.after ? short(c.after) : 'not recorded';
  if (c.before === null) return `sha256 ${a} (it was not there before)`;
  if (c.after === null) return `sha256 ${c.before ? short(c.before) : 'not recorded'} before; deleted`;
  if (c.before === undefined) return `sha256 ${a}; before: not recorded`;
  return `sha256 ${short(c.before)} ${arrow} ${a}`;
}

/** A change's lines: how and the path, who, the hashes and now, the previous version, the record, the diff, the restore. */
export function changeLines(c: ReviewChange, o: { glyphs: GlyphSet; link?: (rel: string) => string }): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const link = o.link ?? ((rel: string) => rel);
  const lines: Line[] = [[{ text: `    ${c.how.padEnd(9)}` }, { text: link(visible(c.path)), role: 'strong' }]];
  lines.push([{ text: PAD }, { text: `by ${visible(c.by)}${c.note ? `${sep}${visible(c.note)}` : ''}`, role: 'secondary' }]);
  lines.push([{ text: PAD }, { text: shaWords(c, g.arrow), role: 'secondary' }, { text: sep, role: 'secondary' }, { text: `now: ${c.now.words}`, role: NOW_ROLE[c.now.state] }]);
  lines.push([{ text: PAD }, { text: visible(c.keptWords), role: c.kept && c.kept.state !== 'ok' ? 'estimate' : 'secondary' }]);
  const check: Segment = { text: `${c.check.status}: ${visible(c.check.words)}`, role: CHECK_ROLE[c.check.status] };
  lines.push(c.record ? [{ text: PAD }, { text: 'record ', role: 'secondary' }, { text: link(visible(c.record)) }, { text: sep, role: 'secondary' }, check] : [{ text: PAD }, { text: 'its receipt is its record', role: 'secondary' }, { text: sep, role: 'secondary' }, check]);
  if (c.diff && !c.diff.shown) lines.push([{ text: PAD }, { text: `no line diff: ${visible(c.diff.why)}`, role: 'secondary' }]);
  if (c.diff?.shown) {
    const d = c.diff.change;
    lines.push([{ text: PAD }, { text: `line diff, the kept version ${g.arrow} ${c.how === 'deleted' ? 'deleted' : 'the file as the run left it'}: +${d.added} −${d.removed} in ${d.hunks_total} place${d.hunks_total === 1 ? '' : 's'}`, role: 'secondary' }]);
    for (const h of d.hunks) {
      lines.push([{ text: `${PAD}  ` }, { text: `@ line ${h.before_line} (now line ${h.after_line})`, role: 'secondary' }]);
      for (const l of h.removed) lines.push([{ text: `${PAD}  ` }, { text: `- ${visible(l)}`, role: 'diffRemove' }]);
      if (h.removed_total > h.removed.length) lines.push([{ text: `${PAD}  ` }, { text: `  and ${h.removed_total - h.removed.length} more lines taken out`, role: 'secondary' }]);
      for (const l of h.added) lines.push([{ text: `${PAD}  ` }, { text: `+ ${visible(l)}`, role: 'diffAdd' }]);
      if (h.added_total > h.added.length) lines.push([{ text: `${PAD}  ` }, { text: `  and ${h.added_total - h.added.length} more lines put in`, role: 'secondary' }]);
    }
    if (d.hunks_total > d.hunks.length) lines.push([{ text: `${PAD}  ` }, { text: `and ${d.hunks_total - d.hunks.length} more places`, role: 'secondary' }]);
  }
  lines.push(c.restore.offered
    ? [{ text: PAD }, { text: visible(c.restore.command), role: 'strong' }]
    : [{ text: PAD }, { text: `restore: not offered: ${visible(c.restore.why)}`, role: 'secondary' }]);
  return lines;
}

/** One operation's head line and its changes. */
export function operationLines(op: ReviewOperation, o: { glyphs: GlyphSet; link?: (rel: string) => string }): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const mark = op.tone === 'running' ? g.bullet : op.tone === 'failed' ? g.fail : op.tone === 'ok' ? g.ok : ' ';
  const lines: Line[] = [[
    { text: `  ${mark} ` }, { text: `Operation ${op.id}`, role: 'strong' }, { text: `  ${op.state}  ` },
    { text: `${visible(op.request.length > 90 ? `${op.request.slice(0, 89)}…` : op.request)}${op.via ? `${sep}${op.via}` : ''}${op.started ? `${sep}${stamp(op.started)}` : ''}`, role: 'secondary' },
  ]];
  if (!op.changes.length) lines.push([{ text: `    ${'nothing'.padEnd(9)}` }, { text: 'it changed no file Timmy records', role: 'secondary' }]);
  for (const c of op.changes) lines.push(...changeLines(c, o));
  if (op.more) lines.push([{ text: `    ${moreWords(op)}`, role: 'secondary' }]);
  for (const n of op.notes) lines.push([{ text: `    ${'note'.padEnd(9)}` }, { text: visible(n), role: 'secondary' }]);
  return lines;
}

/** `/review`: the newest operations that changed files, each in full. */
export function reviewLines(v: ReviewView, o: { glyphs: GlyphSet; link?: (rel: string) => string; project: string }): Line[] {
  const sep = ` ${o.glyphs.sep} `;
  const lines: Line[] = [[
    { text: '  Review     ', role: 'secondary' }, { text: `what recent operations changed in ${o.project}`, role: 'strong' },
    { text: `${sep}each file checked now against what its run left${sep}/review <operation> for one`, role: 'secondary' },
  ]];
  if (!v.operations.length) {
    lines.push([{ text: `    Nothing to review: none of the ${v.looked} newest operations changed a file Timmy records. /ops lists the operations.`, role: 'secondary' }]);
    return lines;
  }
  for (const op of v.operations) lines.push(...operationLines(op, o));
  if (v.quiet) lines.push([{ text: `  ${v.quiet} other recent operation${v.quiet === 1 ? '' : 's'} changed no file Timmy records${sep}/ops lists them`, role: 'secondary' }]);
  lines.push([{ text: `  A restore writes a kept previous version back only over the file exactly as its run left it, keeps the version it replaces under .timmy/restore-history/ and seals an edit receipt.`, role: 'secondary' }]);
  return lines;
}

/** `/restore`'s answer: what was written and kept, and the receipt; or the refusal, with nothing written. */
export function restoredLines(r: Restored, o: { glyphs: GlyphSet; link?: (rel: string) => string }): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const link = o.link ?? ((rel: string) => rel);
  if (!r.ok) {
    if (r.usage) return [[{ text: `  ${r.why}`, role: 'secondary' }]];
    const lines: Line[] = [[{ text: '  Refused    ', role: 'failure' }, { text: `${visible(r.why)}. Nothing was written.` }]];
    if (r.change) lines.push([{ text: PAD }, { text: `${visible(r.change.path)} ${r.change.how} by ${visible(r.change.by)}${r.change.operation ? `${sep}/review ${r.change.operation}` : ''}`, role: 'secondary' }]);
    return lines;
  }
  return [
    [{ text: '  Restored   ', role: 'secondary' }, { text: link(visible(r.file)), role: 'strong' }, { text: `  from ${visible(r.from)}`, role: 'secondary' }],
    [{ text: PAD }, { text: `sha256 ${short(r.sha256)} now (${r.previous ? `it was ${short(r.previous)}, as ${visible(r.change.by)} left it` : `it was not there: ${visible(r.change.by)} deleted it`})`, role: 'secondary' }],
    ...(r.kept ? [[{ text: PAD }, { text: 'the version it replaced is kept at ', role: 'secondary' }, { text: link(visible(r.kept)) }] as Line] : []),
    ...(r.note ? [[{ text: PAD }, { text: r.note, role: 'secondary' }] as Line] : []),
    [{ text: PAD }, { text: r.receipt ? `receipt ${r.receipt} (edit, human-gated)` : 'no receipt was sealed', role: r.receipt ? 'secondary' : 'estimate' }, { text: `${sep}/review shows it`, role: 'secondary' }],
  ];
}
