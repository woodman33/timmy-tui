/**
 * Round R4 (H120): when a distribution becomes a recommendation (src/decision/judge.ts, the lead's): the highest option at
 * least minTop and ahead of the second by at least minMargin; a tie, a low top, a thin margin or "needs review" ranked first
 * abstain (a person decides). Thresholds are settings, evaluated here.
 */
import { describe, expect, it } from 'vitest';
import { checkThresholds, DEFAULT_THRESHOLDS, judge, NEEDS_REVIEW } from '../src/decision/judge.js';
import { readFixture } from './fixtures/clef-omni/fake.js';

const dist = (name: string): Record<string, number> =>
  ((readFixture(name) as { answers: { route: { probabilities: Record<string, number> } } }).answers.route.probabilities);

describe('judge with the default thresholds (0.60 and 0.15)', () => {
  it('recommends a clear leader', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ minTop: 0.6, minMargin: 0.15 });
    const j = judge(dist('response-route-ok.json'));
    expect(j.kind).toBe('recommend');
    if (j.kind === 'recommend') {
      expect(j.option).toBe('codex');
      expect(j.top).toBeCloseTo(0.71);
      expect(j.margin).toBeCloseTo(0.54);
    }
  });

  it('abstains on a tie, naming both', () => {
    const j = judge(dist('response-route-tie.json'));
    expect(j.kind).toBe('abstain');
    if (j.kind === 'abstain') expect(j.reason).toBe('a tie between codex and pi at 45.0%');
  });

  it('abstains when the highest option is below 60%', () => {
    const j = judge(dist('response-route-low.json'));
    expect(j.kind).toBe('abstain');
    if (j.kind === 'abstain') {
      expect(j.reason).toBe('the highest option (pi, 38.0%) is below the 60.0% threshold');
      expect(j.leader).toBe('pi');
    }
  });

  it('abstains when "needs review" is ranked first, whatever its margin', () => {
    const j = judge(dist('response-route-needs-review.json'));
    expect(j.kind).toBe('abstain');
    if (j.kind === 'abstain') {
      expect(j.leader).toBe(NEEDS_REVIEW);
      expect(j.reason).toMatch(/ranked "needs review" first \(70\.0%\)/);
    }
    // even a near-certain needs_review is an abstention, never a recommendation of "needs_review"
    expect(judge({ codex: 0.01, pi: 0.01, needs_review: 0.98 }).kind).toBe('abstain');
  });

  it('abstains on a thin margin above the top threshold', () => {
    const j = judge({ codex: 0.62, pi: 0.5, needs_review: 0 });
    expect(j.kind).toBe('abstain');
    if (j.kind === 'abstain') expect(j.reason).toMatch(/codex leads by 12\.0%, below the 15\.0% margin/);
  });

  it('recommends just above both thresholds and abstains just below each', () => {
    expect(judge({ codex: 0.61, pi: 0.39, needs_review: 0 }).kind).toBe('recommend');
    expect(judge({ codex: 0.59, pi: 0.2, openhands: 0.2, needs_review: 0.01 }).kind).toBe('abstain');
    expect(judge({ codex: 0.6, pi: 0.46, needs_review: 0 }).kind).toBe('abstain');
    expect(judge({ codex: 0.7, pi: 0.54, needs_review: 0 }).kind).toBe('recommend');
  });

  it('a tie is found whatever the option order, and between any two leaders', () => {
    const a = judge({ pi: 0.5, codex: 0.5, needs_review: 0 });
    const b = judge({ codex: 0.5, pi: 0.5, needs_review: 0 });
    expect(a).toEqual(b);
    expect(a.kind).toBe('abstain');
  });

  it('abstains when nothing was scored', () => {
    expect(judge({})).toEqual({ kind: 'abstain', reason: 'no options were scored', top: 0, margin: 0 });
  });
});

describe('judge with other thresholds', () => {
  it('lower thresholds recommend the low fixture\'s leader; higher ones abstain on the clear one', () => {
    const low = judge(dist('response-route-low.json'), { minTop: 0.3, minMargin: 0.05 });
    expect(low.kind).toBe('recommend');
    if (low.kind === 'recommend') expect(low.option).toBe('pi');
    expect(judge(dist('response-route-low.json'), { minTop: 0.3, minMargin: 0.1 }).kind).toBe('abstain');
    expect(judge(dist('response-route-ok.json'), { minTop: 0.8, minMargin: 0.15 }).kind).toBe('abstain');
    expect(judge(dist('response-route-ok.json'), { minTop: 0.6, minMargin: 0.6 }).kind).toBe('abstain');
  });

  it('a tie abstains even with a zero margin threshold', () => {
    expect(judge(dist('response-route-tie.json'), { minTop: 0.1, minMargin: 0 }).kind).toBe('abstain');
  });
});

describe('checkThresholds', () => {
  it('accepts the defaults and sensible values', () => {
    expect(checkThresholds(DEFAULT_THRESHOLDS)).toEqual([]);
    expect(checkThresholds({ minTop: 1, minMargin: 0 })).toEqual([]);
  });

  it('refuses values outside their ranges, in words', () => {
    expect(checkThresholds({ minTop: 0, minMargin: 0.1 })).toEqual(['minTop must be above 0 and at most 1']);
    expect(checkThresholds({ minTop: 1.2, minMargin: 0.1 })).toEqual(['minTop must be above 0 and at most 1']);
    expect(checkThresholds({ minTop: 0.6, minMargin: 1 })).toEqual(['minMargin must be from 0 to below 1']);
    expect(checkThresholds({ minTop: 0.6, minMargin: -0.1 })).toEqual(['minMargin must be from 0 to below 1']);
    expect(checkThresholds({ minTop: Number.NaN, minMargin: Number.NaN })).toHaveLength(2);
  });
});
