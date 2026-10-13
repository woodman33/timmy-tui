/**
 * Round R4 (H51): `/op [<id>]` and `/ops` in the REPL: an operation's card (src/ops/card.ts) as text, and the project's
 * recent operations, running first. Every string comes from the card, already scrubbed; colour only repeats a word (an
 * outcome is never green: green is for commands).
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Role, Segment } from '../term/theme.js';
import type { CardCheck, CardTone, OperationCard } from './card.js';

type Line = Segment[];
const TONE_ROLE: Readonly<Record<CardTone, Role | undefined>> = { running: 'estimate', ok: undefined, failed: 'failure', stopped: 'secondary', attention: 'estimate', neutral: undefined };
const stamp = (iso: string | null | undefined): string => (iso && !Number.isNaN(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time');
const CHECK_ROLE: Readonly<Record<CardCheck['status'], Role | undefined>> = { verified: 'secondary', stale: 'estimate', unverified: 'estimate', missing: 'failure' };

export function mark(t: CardTone, g: GlyphSet): string {
  return t === 'running' ? g.bullet : t === 'ok' ? g.ok : t === 'failed' ? g.fail : t === 'attention' ? '!' : ' ';
}

/** `/op <id>`: one operation, followed through everything it made. */
export function cardLines(c: OperationCard, o: { glyphs: GlyphSet; link?: (rel: string) => string }): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const link = o.link ?? ((rel: string) => rel);
  const label = (t: string): Segment => ({ text: `  ${t.padEnd(11)}`, role: 'secondary' });
  const pad: Segment = { text: '             ' };
  const check = (c_: CardCheck): Segment => ({ text: `${c_.status}: ${c_.words}`, role: CHECK_ROLE[c_.status] });
  const cmds = (list: string[]): Line => [pad, { text: list.join(sep), role: 'strong' }];
  const lines: Line[] = [[
    { text: `  ${mark(c.tone, g)} `, role: c.tone === 'failed' ? 'failure' : undefined }, { text: `Operation ${c.id}`, role: 'strong' }, { text: '  ' }, { text: c.state, role: TONE_ROLE[c.tone] },
  ]];
  lines.push([label('Request'), { text: c.request }, { text: `${sep}${c.via ?? 'where unknown'}${c.started ? `${sep}started ${stamp(c.started)}` : ''}${c.ended ? `${sep}ended ${stamp(c.ended)}` : ''}${c.parent ? `${sep}continues ${c.parent}` : ''}`, role: 'secondary' }]);
  // R4 (H60): what of it waits on a person (/decisions has each in full).
  for (const [i, w] of (c.waiting ?? []).entries()) lines.push([label(i === 0 ? 'Waiting' : ''), { text: `on you: ${w}`, role: 'estimate' }, ...(i === 0 ? [{ text: `${sep}/decisions`, role: 'secondary' as const }] : [])]);
  if (c.why) lines.push([label('Why'), { text: c.why }]);
  if (c.note) lines.push([label('Note'), { text: c.note, role: 'estimate' }]);
  lines.push([label('Record'), c.record ? { text: link(c.record) } : { text: c.recordError ?? 'none here', role: 'secondary' }]);
  for (const w of c.workflows) {
    lines.push([label('Workflow'), { text: `${w.doc} › ${w.block}`, role: 'strong' }, { text: `  job ${w.job}  ` }, { text: w.state, role: TONE_ROLE[w.tone] }]);
    if (w.steps.length) lines.push([pad, { text: w.steps.map((s, i) => `${i + 1} ${s.name} ${s.state}${s.code !== undefined && s.state === 'failed' ? ` (exit ${s.code})` : ''}`).join(sep) }]);
    // R4 (H74): each block's own receipt
    const sealed = w.steps.flatMap((s) => (s.receipt ? [`block ${s.name}: receipt ${s.receipt}`] : []));
    if (sealed.length) lines.push([pad, { text: sealed.join(sep), role: 'secondary' }]);
    lines.push([pad, check(w.check)]);
    lines.push(cmds(w.commands));
  }
  for (const f of c.flows) {
    lines.push([label('Flow'), { text: f.id, role: 'strong' }, { text: `  ${f.kind}  ` }, { text: f.verdict, role: TONE_ROLE[f.tone] }]);
    if (f.instruction) lines.push([pad, { text: `"${f.instruction}"`, role: 'secondary' }]);
    if (f.steps.length) lines.push([pad, { text: f.steps.map((s, i) => `${i + 1} ${s.name} (${s.role ?? 'role not recorded'}) ${s.state}`).join(sep) }]);
    lines.push([pad, check(f.check)]);
    lines.push(cmds(f.commands));
  }
  for (const out of c.outputs) {
    lines.push([label('Output'), { text: link(out.path) }, { text: `  ${out.role}${sep}by ${out.by}`, role: 'secondary' }]);
    lines.push([pad, check(out.check)]);
    lines.push(cmds(out.commands));
  }
  for (const v of c.vox) {
    lines.push([label('VoxVision'), { text: v.id, role: 'strong' }, { text: `  ${v.action} ${v.inputs.join(' and ')}  ` }, { text: v.status, role: TONE_ROLE[v.tone] }, { text: `${sep}about ${v.about}`, role: 'secondary' }]);
    for (const val of v.values) lines.push([pad, { text: val }]);
    lines.push([pad, check(v.check)]);
    lines.push(cmds(v.commands));
  }
  for (const l of c.lessons) {
    lines.push([label('Lesson'), { text: l.id, role: 'strong' }, { text: '  ' }, { text: l.status, role: TONE_ROLE[l.tone] }, { text: `  ${l.text}` }]);
    if (l.relation) lines.push([pad, { text: l.relation, role: 'secondary' }]);
    for (const e of l.evidence) lines.push([pad, { text: `${e.what}: ` }, check(e.check)]);
    lines.push(cmds(l.commands));
  }
  if (!c.lessons.length) lines.push([label('Lessons'), { text: 'none in .timmy/memory/lessons names this operation or its records, and none was given to its runs', role: 'secondary' }]);
  for (const e of c.lessonErrors) lines.push([label('Unreadable'), { text: e, role: 'estimate' }]);
  if (c.runs.length) {
    lines.push([label('Runs'), { text: `${c.runs.length}, each with its role`, role: 'secondary' }]);
    for (const r of c.runs) lines.push([pad, { text: `${r.kind} ${r.id}` }, { text: `  ${r.role}  `, role: 'secondary' }, { text: r.state, role: TONE_ROLE[r.tone] }]);
  }
  lines.push([label('Receipts'), { text: c.receipts.length ? c.receipts.map((r) => `${r.kind} ${r.id}`).join(sep) : 'none sealed under it yet', role: 'secondary' }]);
  lines.push([label('Next'), { text: c.commands.join(sep), role: 'strong' }]);
  return lines;
}

/** `/ops`: the project's recent operations, running first, one line each. */
export function opsLines(cards: OperationCard[], o: { glyphs: GlyphSet; project: string; unreadable: Array<{ rel: string; error: string }> }): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const lines: Line[] = [[{ text: '  Operations', role: 'strong' }, { text: ` in ${o.project}${sep}running first, then the newest; one request each`, role: 'secondary' }]];
  if (!cards.length) lines.push([{ text: '    None recorded yet: a command that starts or seals something leaves one (.timmy/operations/).', role: 'secondary' }]);
  for (const c of cards) {
    const parts = [c.workflows.length ? `${c.workflows.length} workflow run${c.workflows.length === 1 ? '' : 's'}` : '', c.flows.length ? `${c.flows.length} flow${c.flows.length === 1 ? '' : 's'}` : '', c.vox.length ? `${c.vox.length} VoxVision` : '', c.outputs.length ? `${c.outputs.length} output${c.outputs.length === 1 ? '' : 's'}` : '', c.lessons.length ? `${c.lessons.length} lesson${c.lessons.length === 1 ? '' : 's'}` : '',
      c.waiting?.length ? `${c.waiting.length} waiting on you` : ''].filter(Boolean).join(', '); // R4 (H60)
    lines.push([
      { text: `  ${mark(c.tone, g)} `, role: c.tone === 'failed' ? 'failure' : undefined }, { text: c.id, role: 'strong' }, { text: `  ${c.state.padEnd(10)} `, role: TONE_ROLE[c.tone] },
      { text: c.request.length > 70 ? `${c.request.slice(0, 69)}…` : c.request }, { text: `${c.started ? `${sep}${stamp(c.started)}` : ''}${parts ? `${sep}${parts}` : ''}`, role: 'secondary' },
    ]);
  }
  for (const u of o.unreadable) lines.push([{ text: `    unreadable ${u.rel}: ${u.error}`, role: 'estimate' }]);
  lines.push([{ text: `  One in full: /op <id>${sep}the newest: /op${sep}on the board: /board live`, role: 'secondary' }]);
  return lines;
}
