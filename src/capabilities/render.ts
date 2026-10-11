/** `/tools` and `timmy tools`: the capability rows as grouped lines, or as JSON (round R1). */
import type { GlyphSet } from '../term/glyphs.js';
import type { Role, Segment } from '../term/theme.js';
import { truncate, visibleWidth } from '../term/width.js';
import { demonstratedWords, LEDGER, type Demonstration } from './demonstrations.js';
import { emptyLadder, RUNG_MEANS, RUNG_ORDER, RUNGS, type LadderRung } from './ladder.js';
import { KIND_TITLES, type CapabilityRow, type Kind, type Rung } from './index.js';

/** The rung is always a word; color only repeats it (never green: no rung is an outcome). */
const RUNG_ROLE: Record<Rung, Role | undefined> = {
  'proposed': 'secondary', 'needs setup': 'estimate', 'installed': undefined, 'reachable': 'strong', 'exercised': 'strong', 'qualified': 'strong',
};

const day = (iso: string): string => iso.slice(0, 10);
const when = (iso: string | undefined): string => (iso && !Number.isNaN(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time');

/** R4 (H76): what a demonstration on the operator's Mac is, wherever one is shown. */
export const DEMONSTRATED_IS = 'a recorded, scripted run of Timmy on the operator\'s Mac, in the ledger; it never raises a rung here';

/**
 * R4 (H46): the agent tools a row covers (what `--json` lists as its tools), on lines of their own under it, wrapped
 * between names; a name is never cut (one longer than the room has a line of its own): on the Mac the OpenSCAD and
 * FreeCAD rows never showed iterate_native, as the table showed no tools at all.
 */
function toolLines(tools: string[], columns: number): Segment[][] {
  const lead = '      tools: ';
  const indent = ' '.repeat(lead.length);
  const max = Math.max(lead.length + 1, columns - 1);
  const out: string[] = [];
  let line = lead;
  tools.forEach((t, i) => {
    const piece = `${t}${i < tools.length - 1 ? ',' : ''}`;
    if (line !== lead && line !== indent && visibleWidth(line) + 1 + visibleWidth(piece) > max) { out.push(line); line = indent; }
    line += `${line === lead || line === indent ? '' : ' '}${piece}`;
  });
  out.push(line);
  return out.map((l) => [{ text: l, role: 'secondary' as const }]);
}

export function capabilityLines(rows: CapabilityRow[], glyphs: GlyphSet, columns: number): Segment[][] {
  const nameWidth = Math.min(27, Math.max(...rows.map((r) => visibleWidth(r.name))) + 2);
  const rungWidth = 13;
  const lines: Segment[][] = [];
  let kind: Kind | null = null;
  for (const r of rows) {
    if (r.kind !== kind) {
      if (kind) lines.push([]);
      kind = r.kind;
      lines.push([{ text: `  ${KIND_TITLES[r.kind]}`, role: 'strong' }]);
    }
    const name = truncate(r.name, nameWidth - 1, glyphs.ellipsis);
    const head = `  ${name}${' '.repeat(Math.max(1, nameWidth - visibleWidth(name)))}`;
    // The step comes first when there is one: it is what to do; the state follows if it fits.
    const room = Math.max(8, columns - 1 - visibleWidth(head) - rungWidth);
    const used = r.exercised ? ` ${glyphs.sep} used ${day(r.exercised)}` : '';
    const main = r.setup ? `do: ${r.setup}` : r.detail;
    const extra = r.setup ? ` (${r.detail})` : '';
    const rung: Segment = { text: r.rung.padEnd(rungWidth), role: RUNG_ROLE[r.rung] };
    if (visibleWidth(`${main}${extra}${used}`) <= room) {
      lines.push([{ text: head }, rung, { text: `${main}${extra}${used}`, role: r.setup ? undefined : 'secondary' }]);
    } else {
      // A step that does not fit goes on its own line, whole where it can be: a cut step cannot be followed.
      lines.push([{ text: head }, rung, { text: truncate(`${r.detail}${used}`, room, glyphs.ellipsis), role: 'secondary' }]);
      if (r.setup) lines.push([{ text: truncate(`      do: ${r.setup}`, columns - 1, glyphs.ellipsis) }]);
    }
    if (r.tools?.length) lines.push(...toolLines(r.tools, columns));
    // R4 (H76): what a proposed row's plan says, the qualification a qualified row has, and the Mac's demonstrations.
    const sub = (text: string): void => void lines.push([{ text: truncate(`      ${text}`, columns - 1, glyphs.ellipsis), role: 'secondary' }]);
    if (r.ladder?.proposed) sub(`proposed in ${r.ladder.proposed.plan.split('/').at(-1)}, ${r.ladder.proposed.section.split(': ').at(-1)}`);
    if (r.rung === 'qualified' && r.ladder?.qualified) sub(`qualified: ${r.ladder.qualified.what}`);
    if (r.demonstrated?.length) sub(`on the Mac (scripted): ${demonstratedWords(r.demonstrated, glyphs.sep)}`);
  }
  lines.push([]);
  // The legend, whole: one state per phrase, wrapped between phrases.
  const phrases = [...RUNG_ORDER.map((s) => `${s}: ${RUNG_MEANS[s]}`), 'on the Mac: a scripted demonstration in the ledger, never a rung', 'one row in full: /tools <name>'];
  let line = '';
  for (const p of phrases) {
    const next = line ? `${line} ${glyphs.sep} ${p}` : `  ${p}`;
    if (line && visibleWidth(next) > columns - 1) { lines.push([{ text: truncate(line, columns - 1, glyphs.ellipsis), role: 'secondary' }]); line = `  ${p}`; }
    else line = next;
  }
  if (line) lines.push([{ text: truncate(line, columns - 1, glyphs.ellipsis), role: 'secondary' }]);
  return lines;
}

/**
 * `timmy tools --json`: every row with stable keys: its rung, `ladder` (one evidence object per rung, null when not
 * reached), `notReached` (why, in words), and `demonstrated` (the Mac's demonstrations, a separate fact).
 */
export function capabilityJson(rows: CapabilityRow[], at: Date = new Date()): Record<string, unknown> {
  return {
    checkedAt: at.toISOString(),
    ladder: [...RUNGS],
    needsSetup: RUNG_MEANS['needs setup'],
    rungWords: { ...RUNG_MEANS },
    demonstrated: { ledger: LEDGER, is: DEMONSTRATED_IS },
    rows: rows.map((r) => ({ ...r, ladder: r.ladder ?? emptyLadder(), notReached: r.notReached ?? {}, demonstrated: r.demonstrated ?? [] })),
  };
}

// ── /tools <name>: one row in full (the advanced view) ────────────────────────

/** The rows a name names: an exact id first, then an exact name, then a unique start or part of a name or id. */
export function findRows(rows: readonly CapabilityRow[], query: string): CapabilityRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const id = rows.filter((r) => r.id.toLowerCase() === q);
  if (id.length) return id;
  const name = rows.filter((r) => r.name.trim().toLowerCase() === q);
  if (name.length) return name;
  const starts = rows.filter((r) => r.name.trim().toLowerCase().startsWith(q) || r.id.toLowerCase().startsWith(q));
  if (starts.length) return starts;
  return rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
}

/** Words wrapped to a width, between words (a word longer than the width is cut into pieces). */
function wrap(text: string, width: number): string[] {
  const w = Math.max(12, width);
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (visibleWidth(rest) > w) { if (line) { out.push(line); line = ''; } out.push(rest.slice(0, w)); rest = rest.slice(w); }
    if (!line) line = rest;
    else if (visibleWidth(line) + 1 + visibleWidth(rest) <= w) line += ` ${rest}`;
    else { out.push(line); line = rest; }
  }
  if (line || !out.length) out.push(line);
  return out;
}

/**
 * Each rung's evidence in words, or why it is not reached ("not reached: …"), the advanced view's text for one rung (the
 * board's too). A built tool is past "proposed": its words say so, without "not reached".
 */
export function rungText(r: CapabilityRow, rung: LadderRung): { reached: boolean; text: string } {
  const l = r.ladder;
  const why = r.notReached?.[rung];
  const not = (w: string | undefined): { reached: false; text: string } => ({ reached: false, text: `not reached: ${w ?? 'not read'}` });
  switch (rung) {
    case 'proposed': return l?.proposed
      ? { reached: true, text: `${l.proposed.plan}, ${l.proposed.section}: "${l.proposed.says}"` }
      : { reached: false, text: why ?? 'not read' };
    case 'installed': return l?.installed
      ? { reached: true, text: [l.installed.found, l.installed.where ? `where: ${l.installed.where}` : '', l.installed.how ? `how: ${l.installed.how}` : '', l.installed.version ? `version ${l.installed.version}${l.installed.versionFrom ? ` (${l.installed.versionFrom})` : ''}` : 'version: not asked'].filter(Boolean).join(' · ') }
      : not(why);
    case 'reachable': return l?.reachable
      ? { reached: true, text: `asked ${l.reachable.asked} · answered ${when(l.reachable.at)}: ${l.reachable.answer}` }
      : not(why);
    case 'exercised': return l?.exercised
      ? { reached: true, text: `${l.exercised.what} · ${when(l.exercised.at)} · receipt ${l.exercised.receipt}${l.exercised.record ? ` · record ${l.exercised.record}` : ''} · ${l.exercised.chain}` }
      : not(why);
    case 'qualified': return l?.qualified
      ? { reached: true, text: `${l.qualified.what} · record ${l.qualified.record} · receipt ${l.qualified.receipt}${l.qualified.at ? ` · ${when(l.qualified.at)}` : ''} · it covers ${l.qualified.scope}` }
      : not(why);
  }
}

/** A demonstration in words, with its ledger row. */
export const demonstrationText = (d: Demonstration): string =>
  `${d.result} ${d.run} (ledger row ${d.row}, ${d.date}, ${d.revision}, ${d.how}${d.part ? `, part ${d.part}` : ''}): ${d.outcome}`;

/** `/tools <name>`: one row in full, each rung with its evidence or why it is not reached, and its demonstrations. */
export function capabilityDetailLines(rows: readonly CapabilityRow[], query: string, glyphs: GlyphSet, columns: number): Segment[][] {
  const found = findRows(rows, query);
  if (!found.length) {
    return [[{ text: `  No /tools row is named "${query.trim()}": /tools lists every row (/tools all also lists each lane and vision adapter).`, role: 'secondary' }]];
  }
  if (found.length > 1) {
    return [
      [{ text: `  ${found.length} rows match "${query.trim()}"; /tools <id> shows one:`, role: 'secondary' }],
      ...found.slice(0, 20).map((r): Segment[] => [{ text: `    ${r.id}`, role: 'strong' }, { text: `  ${r.name.trim()}  ` }, { text: r.rung, role: RUNG_ROLE[r.rung] }]),
      ...(found.length > 20 ? [[{ text: `    and ${found.length - 20} more`, role: 'secondary' as const }]] : []),
    ];
  }
  const r = found[0];
  const label = 15;
  const width = Math.max(24, columns - 1 - label);
  const lines: Segment[][] = [[{ text: `  ${r.name.trim()}`, role: 'strong' }, { text: `  id ${r.id} ${glyphs.sep} ${KIND_TITLES[r.kind]}`, role: 'secondary' }]];
  const field = (name: string, text: string, role?: Role, nameRole?: Role): void => {
    wrap(text, width).forEach((part, i) => lines.push([{ text: `  ${(i === 0 ? name : '').padEnd(label - 2)}`, role: nameRole ?? 'secondary' }, { text: part, ...(role ? { role } : {}) }]));
  };
  field('rung', `${r.rung} (${RUNG_MEANS[r.rung]})`, RUNG_ROLE[r.rung]);
  for (const rung of RUNGS) {
    const t = rungText(r, rung);
    field(rung, t.text, t.reached ? undefined : 'secondary', t.reached ? 'strong' : 'secondary');
  }
  const demos = r.demonstrated ?? [];
  if (demos.length) demos.forEach((d, i) => field(i === 0 ? 'on the Mac' : '', demonstrationText(d)));
  else field('on the Mac', `no demonstration in the ledger (${LEDGER})`, 'secondary');
  field('', DEMONSTRATED_IS, 'secondary');
  field('now', r.detail, 'secondary');
  if (r.setup) field('do', r.setup);
  if (r.tools?.length) field('tools', r.tools.join(', '), 'secondary');
  return lines;
}

/** `/tools`, `/tools all` and `/tools <name>`. */
export function toolsView(rows: CapabilityRow[], args: string, glyphs: GlyphSet, columns: number): Segment[][] {
  const a = args.trim();
  return !a || a === 'all' || a === '--all' ? capabilityLines(rows, glyphs, columns) : capabilityDetailLines(rows, a, glyphs, columns);
}
