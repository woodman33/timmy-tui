/** `/tools` and `timmy tools`: the capability rows as grouped lines, or as JSON (round R1). */
import type { GlyphSet } from '../term/glyphs.js';
import type { Role, Segment } from '../term/theme.js';
import { truncate, visibleWidth } from '../term/width.js';
import { KIND_TITLES, type CapabilityRow, type Kind, type Rung } from './index.js';

/** The rung is always a word; color only repeats it (never green: reachable is not proof). */
const RUNG_ROLE: Record<Rung, Role | undefined> = { 'reachable': 'strong', 'installed': undefined, 'needs setup': 'estimate', 'not built': 'secondary' };

const day = (iso: string): string => iso.slice(0, 10);

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
      continue;
    }
    // A step that does not fit goes on its own line, whole where it can be: a cut step cannot be followed.
    lines.push([{ text: head }, rung, { text: truncate(`${r.detail}${used}`, room, glyphs.ellipsis), role: 'secondary' }]);
    if (r.setup) lines.push([{ text: truncate(`      do: ${r.setup}`, columns - 1, glyphs.ellipsis) }]);
  }
  lines.push([]);
  const legend = `  reachable: answered just now ${glyphs.sep} installed: here, not contacted ${glyphs.sep} needs setup: do the step ${glyphs.sep} not built: planned only`;
  lines.push([{ text: truncate(legend, columns - 1, glyphs.ellipsis), role: 'secondary' }]);
  return lines;
}

export function capabilityJson(rows: CapabilityRow[], at: Date = new Date()): Record<string, unknown> {
  return { checkedAt: at.toISOString(), ladder: ['not built', 'needs setup', 'installed', 'reachable'], rows };
}
