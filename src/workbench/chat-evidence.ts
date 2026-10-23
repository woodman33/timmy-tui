/**
 * R11 (H167; step 2b, the plan's section 2 "Each answer" and the order's "Logs are truth"): the evidence line under each answer
 * of the Chat screen, and what Enter on it opens. One row, grey, indented two cells as the playbook's meta rows (§17.1):
 *
 *   <model> · <where> · <seconds> · receipt <id8> ✓
 *
 * the model as the receipt names it (FAKE named), where the turn went (this computer / another computer / OpenRouter, from the
 * receipt's Ollama endpoint or its model asked of OpenRouter), the seconds it took as sealed, its receipt's short id, and ✓
 * (green) only when src/utils/receipts.ts verifyReceiptIn confirmed that receipt in this reading; a turn to OpenRouter says
 * its cost as sealed (a measured amount, or "cost unknown": unknown is never zero); a stopped or failed turn says so first;
 * "no receipt" (amber) where no receipt was found for the answer. Expanded: the tools the turn ran as grouped rows ("● Read",
 * then "  └ <outcome>"; a tool still running "⠋ Running <name>", the braille spinner at 80 ms, in every mode: silence looks
 * like a hang), then the receipt's facts. Pure: words from records, nothing asked.
 */
import type { Glyphs } from './frame.js';
import type { Data, TurnRow } from './model.js';
import { cells, clip, clock, cut, wrapSegs, type Line, type Seg } from './text.js';

const S = (text: string, role: Seg['role'] = 'text', o: Omit<Seg, 'text' | 'role'> = {}): Seg => ({ text, role, ...o });

/** The braille spinner's frame at `now` (80 ms a frame, the playbook §17.6); a plain mark without Unicode. */
export const spinnerFrame = (now: number, g: Pick<Glyphs, 'unicode'>): string => (g.unicode ? '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(now / 80) % 10] : ['|', '/', '-', '\\'][Math.floor(now / 160) % 4]);

/** A model's name as the face says it (a FAKE named FAKE). */
const named = (model: string | null): string => (model ? `${/\bfake\b/i.test(model) ? 'FAKE ' : ''}${model}` : 'model not recorded');

/** Where a sealed turn went, as its receipt says. */
export function turnWhere(t: Pick<TurnRow, 'via' | 'local'>): string {
  if (t.via === 'ollama') return t.local === false ? 'another computer' : 'this computer';
  if (t.via === 'openrouter') return 'OpenRouter';
  return 'where not recorded';
}

/** A sealed turn's cost in words: measured, reported by the provider, or unknown (never zero when unknown). */
export function turnCost(t: Pick<TurnRow, 'cost' | 'via'>): string {
  if (t.via === 'ollama') return 'no charge';
  if (!t.cost || t.cost.usd === null) return 'cost unknown';
  const usd = t.cost.usd === 0 ? '$0' : `$${t.cost.usd < 0.01 ? t.cost.usd.toFixed(4) : t.cost.usd.toFixed(2)}`;
  return t.cost.measured ? usd : `${usd} (reported)`;
}

const seconds = (ms: number | undefined): string => (ms === undefined ? 'time not recorded' : `${(ms / 1000).toFixed(1)} s`);

/**
 * The evidence line's segments (without the indent): the turn's facts, or "no receipt". Where the row is too narrow for
 * them whole, the model's name is cut first (it is whole on the row above, TIMMY / <model>), then the cost gives way (the
 * opened facts say it); the receipt's id is never cut.
 */
export function evidenceSegs(t: TurnRow | undefined, o: { width?: number } = {}): Seg[] {
  if (!t) return [S('no receipt', 'attention')];
  const sep = ' · ';
  const head = t.state === 'answered' ? [] : [S(t.state, t.state === 'failed' ? 'failure' : 'secondary'), S(sep, 'secondary')];
  const name = named(t.model);
  const tailWith = (cost: boolean): string => [turnWhere(t), ...(cost && t.via === 'openrouter' ? [turnCost(t)] : []), seconds(t.ms), `receipt ${t.receipt}`].map((p) => `${sep}${p}`).join('');
  let tail = tailWith(true);
  let shown = name;
  const room = o.width !== undefined ? Math.max(8, o.width - (head.length ? cells(head[0].text) + sep.length : 0) - 2) : cells(name) + cells(tail);
  if (cells(shown) + cells(tail) > room) {
    const nameRoom = room - cells(tail);
    if (nameRoom >= 8) shown = clip(name, nameRoom, '…');
    else {
      tail = tailWith(false);
      const r2 = room - cells(tail);
      shown = r2 >= cells(name) ? name : clip(name, Math.max(8, r2), '…');
    }
  }
  return [...head, S(cut(`${shown}${tail}`, room, '…'), 'secondary', { raw: true }), ...(t.verified?.ok ? [S(' ✓', 'live')] : [])];
}

/** The evidence line as a row: two cells in, then the segments (selected with the answer when it is). */
export function evidenceLine(t: TurnRow | undefined, width: number, sel = false): Line {
  const on = sel ? { selected: true } : {};
  return [S('  ', 'text', on), ...evidenceSegs(t, { width: Math.max(8, width - 2) }).map((s) => ({ ...s, ...on }))];
}

/** A tool as a turn ran it: from the live turn's events (phases) or a receipt's outcomes. */
export interface ToolRun { name: string; outcome?: string; running?: boolean }

/** The live turn's tool events as runs: a start without its end is still running. */
export function toolRuns(events: ReadonlyArray<{ name: string; phase: 'start' | 'end'; outcome?: string }>): ToolRun[] {
  const out: ToolRun[] = [];
  for (const e of events) {
    if (e.phase === 'start') { out.push({ name: e.name, running: true }); continue; }
    const open = [...out].reverse().find((r) => r.running && r.name === e.name);
    if (open) { open.running = false; if (e.outcome) open.outcome = e.outcome; } else out.push({ name: e.name, ...(e.outcome ? { outcome: e.outcome } : {}) });
  }
  return out;
}

/** The tools as grouped rows (the playbook §17.5): "● <name>" then "  └ <outcome>"; a running one with the spinner. */
export function toolRows(runs: readonly ToolRun[], g: Pick<Glyphs, 'unicode' | 'ellipsis'>, now: number, width: number, indent = '  '): Line[] {
  const rows: Line[] = [];
  const room = Math.max(8, width - indent.length - 4);
  for (const r of runs) {
    if (r.running) { rows.push([S(indent, 'text'), S(`${spinnerFrame(now, g)} Running ${cut(r.name, room, g.ellipsis)}`, 'attention')]); continue; }
    rows.push([S(indent, 'text'), S(`${g.unicode ? '●' : '*'} `, 'text'), S(cut(r.name, room, g.ellipsis), 'text')]);
    if (r.outcome) rows.push([S(indent, 'text'), S(`  ${g.unicode ? '└' : '`'} `, 'secondary'), S(cut(r.outcome.replace(/\s+/g, ' '), Math.max(8, room - 4), g.ellipsis), 'secondary', { raw: true })]);
  }
  return rows;
}

/**
 * What Enter on the evidence line opens, under it: the tools the turn ran (the live turn's events for this Workbench's own
 * turn; else the receipt's outcomes), then the receipt's facts. `live`: this Workbench's own turn when the answer is its.
 */
export function evidenceRows(t: TurnRow | undefined, live: Pick<NonNullable<Data['turn']>, 'tools' | 'state'> | null, g: Pick<Glyphs, 'unicode' | 'ellipsis'>, now: number, width: number): Line[] {
  const runs: ToolRun[] = live?.tools.length ? toolRuns(live.tools) : (t?.tools ?? []).map((x) => ({ name: x.name, ...(x.outcome ? { outcome: x.outcome } : {}) }));
  const rows: Line[] = runs.length ? toolRows(runs, g, now, width) : [[S('  '), S('no tool ran', 'secondary')]];
  if (!t) { rows.push(...wrapSegs([S('  '), S('no receipt for this answer: none sealed, or another project\'s', 'attention')], width, '  ')); return rows; }
  rows.push(...wrapSegs([S('  '), S(`sealed ${clock(t.at)} · ${t.operation ? `operation ${t.operation}` : 'no operation'} · ${t.state} · ${turnCost(t)}`, 'secondary')], width, '  '));
  const verified: Seg[] = t.verified ? (t.verified.ok ? [S('verified ', 'live'), S('✓', 'live')] : [S(`not verified: ${t.verified.reason}`, 'failure')]) : [S('receipt not checked', 'secondary')];
  rows.push(...wrapSegs([S('  '), ...verified], width, '  '));
  return rows;
}
