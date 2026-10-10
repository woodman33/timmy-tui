/** `/tools` and `timmy tools`: the capability rows as grouped lines, or as JSON (round R1). */
import type { GlyphSet } from '../term/glyphs.js';
import type { Role, Segment } from '../term/theme.js';
import { truncate, visibleWidth } from '../term/width.js';
import { KIND_TITLES, type CapabilityRow, type Kind, type Rung } from './index.js';

/** The rung is always a word; color only repeats it (never green: reachable is not proof). */
const RUNG_ROLE: Record<Rung, Role | undefined> = { 'reachable': 'strong', 'installed': undefined, 'needs setup': 'estimate', 'not built': 'secondary' };

const day = (iso: string): string => iso.slice(0, 10);

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
  }
  lines.push([]);
  const legend = `  reachable: answered just now ${glyphs.sep} installed: here, not contacted ${glyphs.sep} needs setup: do the step ${glyphs.sep} not built: planned only`;
  lines.push([{ text: truncate(legend, columns - 1, glyphs.ellipsis), role: 'secondary' }]);
  return lines;
}

export function capabilityJson(rows: CapabilityRow[], at: Date = new Date()): Record<string, unknown> {
  return { checkedAt: at.toISOString(), ladder: ['not built', 'needs setup', 'installed', 'reachable'], rows };
}
