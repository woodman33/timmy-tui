import { stripTerminalCodes, visibleWidth } from './text.js';

// ui-cockpit-k7m3 C5 POLISH — bounded rows everywhere.
//
// ink writes the whole frame; a frame taller than the terminal scrolls the
// header off the top (the FILM-PLAN-v2 rails hit this at 80x24, and HANDS with
// a prompt open hit it at both grids). Every list pane therefore takes a row
// cap derived from the viewport, and what a cap hides is SAID in an overflow
// line — never clipped silently (DESIGN.md §3.2). The solver is pure so the
// contract is testable without a TTY.

export interface StackSpec {
  /** card id — names the card in the folded note */
  id: string;
  /** rows the card costs besides its list: borders 2 · title 1 · purpose 0/1 · blank 1 · its static lines */
  fixed: number;
  /** list rows the card would render unbounded */
  items: number;
  /** list rows it keeps before the solver folds the card away entirely */
  min: number;
  /** lower folds first; ties fold the later card first */
  priority: number;
}

export interface StackPlan {
  /** per card: list rows it may render (cap ≥ items ⇒ no overflow line) */
  caps: Record<string, number>;
  /** cards folded away entirely — named in one note line at the stack's foot */
  folded: string[];
  /** rows the plan renders, folded note included */
  rows: number;
  budget: number;
}

const cost = (s: StackSpec, cap: number): number => s.fixed + Math.min(s.items, cap) + (cap < s.items ? 1 : 0);

/**
 * Fit a vertical stack of cards into `budget` rows. Lists shrink first
 * (largest list first, never below its `min`, each shrunk list pays one
 * overflow line); if the minima still do not fit, the lowest-priority card
 * folds away and a one-line note names it. The highest-priority card is
 * never folded: a plan may report rows > budget only when that card's minimum
 * plus the required folded-card note does not fit.
 */
export function fitStack(specs: StackSpec[], budget: number, gap = 1): StackPlan {
  const caps: Record<string, number> = {};
  for (const s of specs) caps[s.id] = s.items;
  const folded: string[] = [];
  const visible = (): StackSpec[] => specs.filter(s => !folded.includes(s.id));
  const total = (): number => {
    const v = visible();
    return v.reduce((n, s) => n + cost(s, caps[s.id]), 0) + Math.max(0, v.length - 1) * gap + (folded.length ? 1 : 0);
  };
  // Fill from the current caps by water level. Binary search makes the work
  // depend on the number of cards and log(items), not the number of hidden rows.
  const growToBudget = (): void => {
    if (total() > budget) return;
    const v = visible();
    const base = { ...caps };
    const apply = (level: number): void => {
      for (const s of v) caps[s.id] = Math.min(s.items, Math.max(base[s.id], level));
    };
    let low = 0;
    let high = Math.max(0, ...v.map(s => s.items));
    while (low < high) {
      const mid = low + Math.ceil((high - low) / 2);
      apply(mid);
      if (total() <= budget) low = mid;
      else high = mid - 1;
    }
    apply(low);
    // At most one partial water level remains. Completing a list can also
    // remove its overflow line, so test the actual cost rather than spare rows.
    for (const s of [...v].sort((a, b) => caps[a.id] - caps[b.id])) {
      if (caps[s.id] >= s.items) continue;
      caps[s.id] += 1;
      if (total() > budget) caps[s.id] -= 1;
    }
  };
  if (total() > budget) {
    for (const s of specs) caps[s.id] = Math.min(s.items, s.min);
    growToBudget();
  }
  // Fold the lowest-priority card while the minima still do not fit.
  while (total() > budget) {
    const v = visible();
    if (v.length <= 1) break;
    const victim = [...v].sort((a, b) => a.priority - b.priority || specs.indexOf(b) - specs.indexOf(a))[0];
    folded.push(victim.id);
    caps[victim.id] = 0;
    growToBudget();
  }
  return { caps, folded, rows: total(), budget };
}

/**
 * Chrome yields before content: try the stack with purpose lines and gaps,
 * then without gaps, then compact (no purpose lines, no gaps), and keep the
 * plan that hides the fewest rows (a folded card counts as three); ties keep
 * the most chrome. `build` returns the specs for a given compact flag.
 */
export function fitStackAdaptive(build: (compact: boolean) => StackSpec[], budget: number): StackPlan & { compact: boolean; gap: number } {
  let best: (StackPlan & { compact: boolean; gap: number; score: number }) | null = null;
  for (const [compact, gap] of [[false, 1], [false, 0], [true, 0]] as const) {
    const specs = build(compact);
    const plan = fitStack(specs, budget, gap);
    const hidden = specs.reduce((n, s) => n + Math.max(0, s.items - plan.caps[s.id]), 0);
    const score = hidden + plan.folded.length * 3 + (plan.rows > budget ? 100 : 0);
    if (!best || score < best.score) best = { ...plan, compact, gap, score };
  }
  const { score: _score, ...plan } = best!;
  return plan;
}

/** first `cap` items and how many were left out */
export function capRows<T>(items: readonly T[], cap: number): { shown: T[]; more: number } {
  const n = Math.max(0, Math.floor(cap));
  return { shown: items.slice(0, n), more: Math.max(0, items.length - n) };
}

/** the overflow line a capped list shows (undefined when nothing is hidden) */
export function moreLine(more: number, noun: string, hint = ''): string | undefined {
  // ▾ not …: the warroom render gates forbid an ellipsis in any cell
  return more > 0 ? `▾ ${more} more ${noun}${hint ? ` · ${hint}` : ''}` : undefined;
}

/** the note a stack shows for the cards it folded away */
export function foldedLine(folded: readonly string[]): string | undefined {
  return folded.length ? `▾ ${folded.join(' · ')} folded — a taller window shows ${folded.length === 1 ? 'it' : 'them'}` : undefined;
}

/**
 * Greedy word wrap at `width` columns (long tokens hard-break) so a wrapped
 * viewer can count the physical rows it will occupy before ink draws them.
 */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function clusterWidth(cluster: string): number {
  // Joined emoji, flags and presentation/keycap sequences occupy one glyph.
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\uFE0F\u20E3]/u.test(cluster)) return 2;
  return visibleWidth(cluster);
}

export function wrapText(text: string, width: number): string[] {
  const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const out: string[] = [];
  // Raw terminal controls are not prompt layout instructions. Tabs have a
  // deterministic four-column representation rather than terminal tab stops.
  const clean = stripTerminalCodes(text).replace(/\t/g, '    ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
  for (const raw of clean.split('\n')) {
    const tokens = raw.split(/(\s+)/).filter(Boolean);
    let line = '';
    let columns = 0;
    let sourceStart = true;
    const flush = (): void => { out.push(line); line = ''; columns = 0; };
    for (const token of tokens) {
      const parts = Array.from(graphemes.segment(token), s => s.segment);
      const tokenColumns = parts.reduce((n, part) => n + clusterWidth(part), 0);
      const space = /^\s+$/.test(token);
      if (space && !sourceStart) {
        if (line && columns + tokenColumns <= w) { line += token; columns += tokenColumns; }
        continue;
      }
      if (!space) {
        sourceStart = false;
        if (line && columns + tokenColumns > w) flush();
      }
      for (const part of parts) {
        const size = clusterWidth(part);
        // An indivisible wide glyph cannot fit a one-column viewport. Render
        // a visible replacement, never half a surrogate or grapheme cluster.
        const shown = size > w ? '\uFFFD' : part;
        const shownWidth = size > w ? 1 : size;
        if (line && columns + shownWidth > w) flush();
        line += shown;
        columns += shownWidth;
      }
    }
    out.push(sourceStart ? line : line.trimEnd());
  }
  return out;
}
