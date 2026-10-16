/**
 * R5 (H134): the parts tab 5 (VoxVision, src/workbench/voxvision-tab.ts) and tab 9 (Tools & MCP, src/workbench/tools-tab.ts)
 * share, beside src/workbench/tab-columns.ts (whose names and signatures stay as they are): parts laid on rows as chips, a
 * receipt verified in one reading (verifyReceiptIn) with its words, a capability row with its rung and step, its detail, a
 * reading not ready yet, and what a terminal cannot draw. Pure: rows in, rows out, every row at most the width it is given.
 */
import type { CapabilityRow } from '../capabilities/index.js';
import { RUNG_MEANS } from '../capabilities/ladder.js';
import { verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import type { Glyphs } from './frame.js';
import type { Lazy } from './model.js';
import { fieldRows, heading, limitRows, onBar, para, S } from './tab-columns.js';
import { cells, clock, fit, lineCells, spread, took, wrapSegs, wrapText, type Line, type Seg } from './text.js';

/**
 * Parts (each a run of segments, kept whole; one wider than a row is cut) laid on rows of `w` cells, `sep` between two on a
 * row, `lead` before the first row and `indent` before every other. At most `max` rows: the last then ends with how many
 * parts are not shown (`more` words it).
 */
export function chips(parts: readonly Line[], w: number, o: { sep: Seg; ellipsis: string; lead?: Line; indent?: string; max?: number; more?: (n: number) => string }): Line[] {
  const lay = (budgetLast: number | null): Array<{ line: Line; n: number }> => {
    const rows: Array<{ line: Line; n: number }> = [];
    let cur = { line: [...(o.lead ?? [])] as Line, n: 0 };
    const room = (): number => (budgetLast !== null && o.max !== undefined && rows.length === o.max - 1 ? budgetLast : w);
    for (const p of parts) {
      const add = (cur.n ? cells(o.sep.text) : 0) + lineCells(p);
      // a part that does not fit goes to the next row (even the first: the lead then keeps its row alone)
      const started = cur.n > 0 || lineCells(cur.line) > cells(o.indent ?? '');
      if (started && lineCells(cur.line) + add > room()) {
        rows.push(cur);
        if (budgetLast !== null && o.max !== undefined && rows.length >= o.max) return rows;
        cur = { line: o.indent ? [S(o.indent)] : [], n: 0 };
      }
      if (cur.n) cur.line.push(o.sep);
      cur.line.push(...p);
      cur.n += 1;
    }
    rows.push(cur);
    return rows;
  };
  let rows = lay(null);
  if (o.max !== undefined && rows.length > o.max) {
    const words = (n: number): string => ` ${o.more ? o.more(n) : `and ${n} more`}`;
    rows = lay(Math.max(1, w - cells(words(parts.length)))).slice(0, o.max);
    const left = parts.length - rows.reduce((a, r) => a + r.n, 0);
    if (left > 0) rows[rows.length - 1].line.push(S(words(left), 'secondary'));
  }
  return rows.map((r) => fit(r.line, w, o.ellipsis));
}

/**
 * The rows of a selected item the screen keeps in view (src/workbench/select.ts keepInView), from `line`: all of them, or,
 * when the item starts on the first page, only those the first page shows. A stacked body carries the selected row's detail
 * under it; counted whole, a detail taller than the page would scroll the body past its top (the search, the pipeline) as
 * soon as the tab opens. Below the first page an item keeps all its rows, so the screen brings its start into view.
 */
export const inViewRows = (line: number, rows: number, height: number): number => (line < height ? Math.max(1, Math.min(rows, height - line)) : rows);

// ── receipts, verified in this reading ─────────────────────────────────────────

/** Whether a receipt verifies where it stands on one reading's chain (verifyReceiptIn: its link and body hash from its
 *  epoch's start, and its signature). */
export type ReceiptVerdict = { ok: true } | { ok: false; reason: string };

/** A receipt's verdict, asked the first time it is shown and kept for this reading only (`checks`). */
export function checkReceipt(receipts: readonly Receipt[], checks: Map<string, ReceiptVerdict>, hash: string): ReceiptVerdict {
  const had = checks.get(hash);
  if (had) return had;
  let v: ReceiptVerdict;
  try {
    const r = verifyReceiptIn(receipts, hash);
    v = r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } catch (e) {
    v = { ok: false, reason: `it could not be checked: ${e instanceof Error ? e.message : String(e)}` };
  }
  checks.set(hash, v);
  return v;
}

/** A receipt's verdict in words, its mark and word a segment of their own (kept whole where the rest is cut): green only
 *  for a receipt verifyReceiptIn confirmed in this reading; a failure amber with ✕ and why. */
export function verdictSegs(v: ReceiptVerdict, g: Glyphs, short = false): Line {
  return v.ok
    ? [S(`${g.ok} verified`, 'live'), S(short ? ' (verifyReceiptIn, now)' : ': link, body hash and signature (verifyReceiptIn, this reading)', 'secondary')]
    : [S(`${g.fail} does not verify`, 'failure'), S(`: ${v.reason}`, 'failure')];
}

// ── capabilities (src/capabilities) ────────────────────────────────────────────

/** A capability row as a list item (src/workbench/model.ts Item's `cap`): the Inspector's own case details it. */
export interface CapItem { kind: 'cap'; key: string; row: CapabilityRow }
export const capItem = (row: CapabilityRow): CapItem => ({ kind: 'cap', key: `cap:${row.id}`, row });

/** What each kind of capability is, in words (All tools' groups: src/workbench/views.ts). */
const KIND_WORDS: Readonly<Record<string, string>> = {
  surface: 'where you work', model: 'a model', tool: 'an agent tool', harness: 'another agent', adapter: 'a native app or adapter', vox: 'VoxVision',
};

/** Whether a rung says the tool is not here to run (quiet, never green). */
export const notHere = (r: Pick<CapabilityRow, 'rung'>): boolean => r.rung === 'needs setup' || r.rung === 'proposed';

/**
 * A capability as a list's rows: its name, and its rung's word whole at the row's end (quiet where it is not here); where the
 * two do not fit on one row, the rung under the name. One that needs setup has its step under it. Nothing green: a rung is
 * not a check made now. The selected one on the selection bar.
 */
export function capRows(r: CapabilityRow, w: number, selected: boolean, g: Glyphs): Line[] {
  const sel = selected ? { selected: true } : {};
  const mark = selected ? S(`${g.cursor} `, 'action', sel) : S('  ');
  const rung = S(r.rung, notHere(r) ? 'secondary' : 'text', sel);
  const bar = (l: Line): Line => (selected ? onBar(l) : l);
  const rows: Line[] = lineCells([mark, S(r.name)]) + 1 + lineCells([rung]) <= w
    ? [bar(spread([mark, S(r.name, 'strong', sel)], [rung], w, g.ellipsis))]
    : [bar(fit([mark, S(r.name, 'strong', sel)], w, g.ellipsis)), bar(spread([S('    ', 'text', sel)], [rung], w, g.ellipsis))];
  // R5 (H131; the QA of e7f853e, defect 11): the step wrapped under itself, never cut ("console.roboflow.…" lost the remedy)
  if (r.rung === 'needs setup' && r.setup) rows.push(...wrapSegs([S('    do: ', 'secondary'), S(r.setup, 'secondary')], w, '        ').map((l) => fit(l, w, g.ellipsis)));
  return rows;
}

/** A capability's detail for a body's column: its rung with what it means (src/capabilities/ladder.ts, as /tools says it), its
 *  state, its step, what it covers, and when a sealed run of Timmy's last used it. `titled`: its heading and name first (not
 *  under its own row in a stacked list, which already says them). */
export function capDetail(r: CapabilityRow, w: number, g: Glyphs, titled = true): Line[] {
  const out: Line[] = titled ? [[heading('Tool'), S(` ${g.sep} ${KIND_WORDS[r.kind] ?? r.kind}`, 'secondary')], ...para(r.name.trim(), w, 'strong')] : [];
  out.push(...fieldRows('Rung', `${r.rung}: ${RUNG_MEANS[r.rung]}`, w, notHere(r) ? 'secondary' : 'text', 8));
  out.push(...fieldRows('State', r.detail, w, 'secondary', 8));
  if (r.setup) out.push(...fieldRows('Step', r.setup, w, 'text', 8));
  if (r.tools?.length) out.push(...fieldRows('Covers', r.tools.join(', '), w, 'secondary', 8));
  out.push(...fieldRows('Used', r.exercised ? `${clock(r.exercised)}, a sealed run of Timmy's` : 'no sealed run of Timmy\'s used it yet', w, 'secondary', 8));
  return out;
}

/** Rows for a reading that is not ready: reading (and for how long), or why it could not be read and how to ask again. */
export function lazyRows<T>(l: Lazy<T>, what: string, w: number, now: number): Line[] | null {
  if (l.state === 'ready') return null;
  if (l.state === 'failed') return para(`${what} could not be read: ${l.why}. [r] reads it again.`, w, 'failure');
  return [[S(`Reading ${what}${l.state === 'loading' ? ` (${took(now - l.since)})` : ''}…`, 'secondary')]];
}

/**
 * What no Timmy surface draws of a tab's subject (`what`: "images, depth, voxels or 3D"), where it is seen instead (`where`:
 * the viewer's words, or none), and what [c] the companion shows for the tab (`c`). R5 (H131; the QA of e7f853e, defect 2):
 * the companion has no such view, so it is never named as where it is seen (tab-columns.ts limitRows).
 */
export function notDrawnRows(what: string, where: string | null, w: number, g: Glyphs, c = 'this tab in a browser page, in words'): Line[] {
  return limitRows(`No Timmy surface draws ${what} yet${where ? `; ${where}` : ''}.`, { c }, w, g);
}
