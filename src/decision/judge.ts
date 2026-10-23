/**
 * Round R4 (lead): when a decision model's distribution becomes a recommendation, and when it does not.
 *
 * The thresholds are settings, never constants hidden in a surface. The defaults (0.60 top, 0.15 margin) are PLACEHOLDERS:
 * they have not been evaluated against outcomes (no labelled set of routing decisions exists yet), and the model's numbers
 * are not calibrated; tests/decision-judge.test.ts checks the rule, not the values. A recommendation still passes Timmy's
 * own admission (scope, privacy, budget, concurrency, isolation, approvals) before anything is dispatched: this file only
 * reads numbers.
 */

/** The abstain option every allowed-choice set carries: "a person should decide". */
export const NEEDS_REVIEW = 'needs_review';

export interface Thresholds {
  /** The highest probability must be at least this. */
  minTop: number;
  /** ...and lead the second by at least this. */
  minMargin: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { minTop: 0.6, minMargin: 0.15 };

export type Judgement =
  | { kind: 'recommend'; option: string; top: number; margin: number }
  | { kind: 'abstain'; reason: string; top: number; margin: number; leader?: string };

export function checkThresholds(t: Thresholds): string[] {
  const problems: string[] = [];
  if (!(t.minTop > 0 && t.minTop <= 1)) problems.push('minTop must be above 0 and at most 1');
  if (!(t.minMargin >= 0 && t.minMargin < 1)) problems.push('minMargin must be from 0 to below 1');
  return problems;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Reads a checked distribution (probabilities over the offered options, summing to 1). */
export function judge(distribution: Record<string, number>, t: Thresholds = DEFAULT_THRESHOLDS): Judgement {
  const ranked = Object.entries(distribution).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [leader, top] = ranked[0] ?? ['', 0];
  const second = ranked[1]?.[1] ?? 0;
  const margin = top - second;
  if (!leader) return { kind: 'abstain', reason: 'no options were scored', top: 0, margin: 0 };
  if (leader === NEEDS_REVIEW) return { kind: 'abstain', reason: `the model ranked "needs review" first (${pct(top)})`, top, margin, leader };
  if (Math.abs(margin) < 1e-9) return { kind: 'abstain', reason: `a tie between ${leader} and ${ranked[1][0]} at ${pct(top)}`, top, margin, leader };
  if (top < t.minTop) return { kind: 'abstain', reason: `the highest option (${leader}, ${pct(top)}) is below the ${pct(t.minTop)} threshold`, top, margin, leader };
  if (margin < t.minMargin) return { kind: 'abstain', reason: `${leader} leads by ${pct(margin)}, below the ${pct(t.minMargin)} margin`, top, margin, leader };
  return { kind: 'recommend', option: leader, top, margin };
}
