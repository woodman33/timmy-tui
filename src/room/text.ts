/**
 * Round R4 (H48): `/room` in the REPL, the Control Room's picture (src/room/index.ts) as text, in the order the
 * operator reads it: what runs now, then the recent runs by who owns them, then the costs line, then the tools that
 * need setup. `/room <run|job|flow id>` shows one run: its route, its handoff chain and its outputs. Every string comes
 * from the room, already cleaned and scrubbed; colour only repeats a word (never green for an outcome).
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Role, Segment } from '../term/theme.js';
import { costsLine, findRun, needsSetup, NOT_OURS, setupCounts, type Room, type RoomRun, type RoomView, type Tone } from './index.js';

type Line = Segment[];

export interface RoomTextOptions {
  glyphs: GlyphSet;
  /** a project path as the terminal shows it (an OSC 8 link where it can); plain text by default */
  link?: (rel: string) => string;
}

const TONE_ROLE: Readonly<Record<Tone, Role | undefined>> = { running: 'estimate', ok: undefined, failed: 'failure', stopped: 'secondary', attention: 'estimate', neutral: undefined };
const stamp = (iso: string | undefined): string => (iso && !Number.isNaN(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time');

function mark(r: RoomRun, g: GlyphSet): string {
  if (r.running) return g.bullet;
  return r.tone === 'ok' ? g.ok : r.tone === 'failed' ? g.fail : r.tone === 'stopped' ? ' ' : '?';
}

/** How a run's cost reads in one phrase. */
export const costWords = (r: RoomRun): string => (r.kind === 'flow' ? `its agent step's cost: ${r.cost.words}` : r.cost.words);

/** One run in two or three lines: who and what state; its route, time and cost; its last progress and how to stop it. */
export function runLines(r: RoomRun, o: RoomTextOptions, indent = '    '): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const what = [r.harness, r.model ? `model ${r.model}` : '', r.route, r.elapsed ?? '', r.step ?? ''].filter(Boolean).join(sep);
  const lines: Line[] = [[
    { text: `${indent}${mark(r, g)} `, role: r.tone === 'failed' ? 'failure' : undefined },
    { text: r.id, role: 'strong' },
    { text: `  ${r.owner}  ` },
    { text: r.state, role: TONE_ROLE[r.tone] },
    { text: `${sep}${what}`, role: 'secondary' },
  ]];
  const after = [r.partOf ?? '', `cost ${costWords(r)}`, r.receipt ? `receipt ${r.receipt}` : ''].filter(Boolean).join(sep);
  lines.push([{ text: `${indent}    ` }, { text: after, role: r.cost.kind === 'unknown' ? 'estimate' : 'secondary' }]);
  if (r.progress) lines.push([{ text: `${indent}    ${g.arrow} `, role: 'secondary' }, { text: r.progress }]);
  if (r.running) {
    const how = r.stop ? `/stop ${r.stop.id} stops it` : r.hint?.words ?? NOT_OURS;
    lines.push([{ text: `${indent}    ` }, { text: how, role: 'secondary' }]);
  }
  return lines;
}

/** `/room`: the whole picture. */
export function roomLines(v: RoomView, o: RoomTextOptions): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const lines: Line[] = [[{ text: '  Control Room ', role: 'strong' }, { text: v.project, role: 'strong' }, { text: `  who runs what in this project, from the runs' own records and receipts`, role: 'secondary' }]];
  lines.push([{ text: '  RUNNING NOW', role: 'strong' }]);
  if (!v.running.length) lines.push([{ text: '    Nothing runs in this project now.', role: 'secondary' }]);
  for (const r of v.running) lines.push(...runLines(r, o));
  lines.push([{ text: '  RECENT, BY OWNER', role: 'strong' }]);
  const groups = v.groups.filter((gr) => gr.recent.length);
  if (!groups.length) lines.push([{ text: '    No finished runs recorded in this project yet.', role: 'secondary' }]);
  for (const gr of groups) {
    lines.push([{ text: `    ${gr.title}`, role: 'strong' }, { text: gr.more ? `  ${gr.recent.length} newest of ${gr.recent.length + gr.more}` : '', role: 'secondary' }]);
    for (const r of gr.recent) lines.push(...runLines(r, o, '      '));
  }
  lines.push([{ text: '  COSTS        ', role: 'strong' }, { text: costsLine(v.costs), role: v.costs.unknown ? 'estimate' : undefined }]);
  lines.push([{ text: '               as recorded on receipts and records; unknown stays unknown, and no budget is shown', role: 'secondary' }]);
  if (!v.tools) {
    lines.push([{ text: '  TOOLS        ', role: 'strong' }, { text: 'not checked here yet', role: 'secondary' }]);
  } else {
    const setup = needsSetup(v.tools.rows);
    const counts = setupCounts(v.tools.rows);
    lines.push([{ text: '  NEEDS SETUP  ', role: 'strong' }, { text: `${setup.length} of the ${counts.named} creative, agent, MCP, vision and model tools${sep}checked ${stamp(v.tools.checkedAt)}`, role: 'secondary' }]);
    for (const t of setup) {
      lines.push([{ text: `    ${t.name.trim()}  ` }, { text: `do: ${t.setup ?? '(no step recorded)'}` }, { text: `  (${t.detail}${t.exercised ? `${sep}used ${t.exercised.slice(0, 10)}` : ''})`, role: 'secondary' }]);
    }
    if (counts.otherNeedSetup) lines.push([{ text: `    and ${counts.otherNeedSetup} other row${counts.otherNeedSetup === 1 ? '' : 's'} of /tools need setup: /tools lists them`, role: 'secondary' }]);
    if (v.tools.note) lines.push([{ text: `    ${v.tools.note}`, role: 'secondary' }]);
  }
  for (const n of v.notes) lines.push([{ text: `  ${n}`, role: 'secondary' }]);
  lines.push([{ text: `  One run: /room <id>${sep}every tool: /tools${sep}the same on the board: /board live`, role: 'secondary' }]);
  return lines;
}

/** `/room <id>`: one run, its handoff chain and its outputs; or why it is not found. */
export function roomItemLines(room: Room, id: string, o: RoomTextOptions): Line[] {
  const g = o.glyphs;
  const sep = ` ${g.sep} `;
  const r = findRun(room.all, id);
  if (!r) return [[{ text: `  No run ${id} in this project's Control Room: /room lists them (a job, an agent run, a flow, a native run, a recipe job, an MCP call or a receipt).`, role: 'secondary' }]];
  const link = o.link ?? ((rel: string) => rel);
  const label = (t: string): Segment => ({ text: `  ${t.padEnd(11)}`, role: 'secondary' });
  const lines: Line[] = [[{ text: `  ${mark(r, g)} `, role: r.tone === 'failed' ? 'failure' : undefined }, { text: r.owner, role: 'strong' }, { text: `  ${r.id}  ` }, { text: r.state, role: TONE_ROLE[r.tone] }]];
  lines.push([label('Route'), { text: [r.harness, r.model ? `model ${r.model}` : '', r.endpoint ? `${r.endpoint} endpoint` : '', r.route].filter(Boolean).join(sep) }]);
  const when = [r.step ?? '', r.startedAt ? `started ${stamp(r.startedAt)}` : '', r.endedAt && !r.running ? `ended ${stamp(r.endedAt)}` : '', r.elapsed ?? ''].filter(Boolean).join(sep);
  if (when) lines.push([label('When'), { text: when }]);
  if (r.partOf) lines.push([label('Part of'), { text: r.partOf }]);
  if (r.progress) lines.push([label(r.running ? 'Progress' : 'Last said'), { text: r.progress }]);
  lines.push([label('Cost'), { text: costWords(r), role: r.cost.kind === 'unknown' ? 'estimate' : undefined }]);
  if (r.handoff?.length) {
    r.handoff.forEach((s, i) => {
      const parts = [s.owner, String(s.state), s.job ? `job ${s.job}` : '', s.receipt ? `receipt ${s.receipt}` : '', s.detail ?? '', s.here ?? ''].filter(Boolean).join(sep);
      lines.push([label(i === 0 ? 'Handoff' : ''), { text: `${i + 1}. ${s.name}  `, role: 'strong' }, { text: parts, role: s.state === 'failed' ? 'failure' : 'secondary' }]);
    });
  }
  if (r.outputs.length) {
    r.outputs.forEach((out, i) => lines.push([label(i === 0 ? 'Outputs' : ''), { text: link(out.path) }, { text: `  ${out.role}`, role: 'secondary' }]));
  } else lines.push([label('Outputs'), { text: 'none named in its record', role: 'secondary' }]);
  const rec = [r.record ? link(r.record) : '', r.recordNote ?? '', r.receipt ? `receipt ${r.receipt}` : 'no receipt seals it yet', ...(r.receipts?.length ? [`its record names receipts ${r.receipts.join(', ')}`] : [])].filter(Boolean).join(sep);
  lines.push([label('Record'), { text: rec }]);
  if (r.running) lines.push([label('Stop'), { text: r.stop ? `/stop ${r.stop.id}` : r.hint?.words ?? NOT_OURS, role: r.stop ? 'strong' : 'secondary' }]);
  return lines;
}
