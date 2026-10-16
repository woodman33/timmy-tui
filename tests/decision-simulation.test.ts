/**
 * Round R4 (H120): a 100-worker simulation without 100 model calls. One decision per distinct request (cached by its
 * request key); distinct queued tasks are scored in batches of questions (a Clef request carries at most 64 questions),
 * so 100 tasks take at most ceil(100/64) calls. Answers come from the fixture transport and FAKE fixtures.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClefRequest } from '../src/decision/clef-contract.js';
import { CLEF_LIMITS } from '../src/decision/clef-contract.js';
import { ClefOmniProvider } from '../src/decision/provider.js';
import { decideBatch, decideDetailed } from '../src/decision/service.js';
import { DEFAULT_DECISION_SETTINGS } from '../src/decision/settings.js';
import type { DecisionInput, DecisionProvider } from '../src/decision/types.js';
import { fakeAnswer, fixture, writeFake } from './fixtures/clef-omni/fake.js';

const ON = { ...DEFAULT_DECISION_SETTINGS, useClef: true };
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'timmy-decide-sim-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function counted(): { calls: ClefRequest[]; provider: DecisionProvider } {
  const inner = new ClefOmniProvider({ transport: 'fixture' });
  const calls: ClefRequest[] = [];
  return { calls, provider: { id: inner.id, describe: () => inner.describe(), decide: (req, o) => { calls.push(req); return inner.decide(req, o); } } };
}
const records = (): string[] => readdirSync(join(root, '.timmy', 'decisions')).filter((n) => /^d[0-9a-f]{8}\.json$/.test(n));

describe('100 workers asking the same route question', () => {
  const route: () => DecisionInput = () => ({
    kind: 'route', operationId: 'o00c0ffee', project: { root, revision: 'rev-sim' },
    instructions: 'Which runtime should take the next worker?', state: { plan: 'FAKE fleet plan f00000001', workers: 100 },
    options: [
      { id: 'codex', label: 'Codex', description: 'Codex CLI', available: true },
      { id: 'pi', label: 'Pi', description: 'Pi', available: true },
      { id: 'openhands', label: 'OpenHands', description: 'OpenHands', available: true },
    ],
    deterministic: { option: 'codex', rule: 'the plan\'s harness' },
  });

  it('all at once: exactly one provider call and one record', async () => {
    const { calls, provider } = counted();
    const ctx = { settings: ON, provider, fixture: fixture('response-route-ok.json') };
    const all = await Promise.all(Array.from({ length: 100 }, () => decideDetailed(route(), ctx)));
    expect(calls).toHaveLength(1);
    expect(records()).toHaveLength(1);
    expect(new Set(all.map((r) => r.record.id)).size).toBe(1);
    expect(all.filter((r) => r.reused)).toHaveLength(99);
    expect(all.every((r) => r.record.outcome === 'recommend' && r.record.recommendation?.option === 'codex')).toBe(true);
  });

  it('one after another: still one call', async () => {
    const { calls, provider } = counted();
    const ctx = { settings: ON, provider, fixture: fixture('response-route-ok.json') };
    for (let i = 0; i < 100; i++) await decideDetailed(route(), ctx);
    expect(calls).toHaveLength(1);
    expect(records()).toHaveLength(1);
  });
});

describe('100 distinct queued tasks prioritized in batches', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `t${String(i + 1).padStart(3, '0')}`);
  // made per test: `root` is this test's own folder only once beforeEach has run
  const queue = (): DecisionInput[] => ids.map((id, i) => ({
    kind: 'queue', operationId: 'o00c0ffee', project: { root, revision: 'rev-sim' }, questionId: id,
    instructions: `Task ${id} (FAKE): ${i % 3 === 0 ? 'fix a failing build' : 'tidy the docs'}. Run it next, or keep it queued?`,
    state: { queue: 'FAKE queue of 100 tasks', running: 4, capacity: 8 },
    options: [
      { id: 'next', label: 'Run next', description: 'Start this task in the next free slot', available: true },
      { id: 'later', label: 'Keep queued', description: 'Leave it in the queue for now', available: true },
    ],
    deterministic: { option: 'later', rule: 'first in, first out' },
  }));
  // FAKE answers for every task's question: a build fix runs next, docs wait, every fifth task is too close to call
  const answerFile = (): string => writeFake(root, 'queue-answers.json', fakeAnswer(Object.fromEntries(ids.map((id, i) => [id,
    i % 5 === 4 ? { next: 0.45, later: 0.45, needs_review: 0.1 } : i % 3 === 0 ? { next: 0.8, later: 0.15, needs_review: 0.05 } : { next: 0.1, later: 0.85, needs_review: 0.05 }]))));

  it('at most ceil(100/64) calls, one record per task, each with its own question\'s distribution', async () => {
    const { calls, provider } = counted();
    const results = await decideBatch(queue(), { settings: ON, provider, fixture: answerFile() });
    expect(calls.length).toBeLessThanOrEqual(Math.ceil(100 / 64));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(Object.keys(c.questions).length).toBeLessThanOrEqual(CLEF_LIMITS.questions.max);
      expect(c.questions.human_review?.type).toBe('noul');
    }
    const asked = calls.flatMap((c) => Object.keys(c.questions).filter((q) => q !== 'human_review'));
    expect(asked.sort()).toEqual(ids);
    expect(results).toHaveLength(100);
    expect(records()).toHaveLength(100);
    const byQ = new Map(results.map((r) => [r.record.question, r.record]));
    expect(byQ.get('t001')).toMatchObject({ kind: 'queue', outcome: 'recommend', recommendation: { option: 'next' } });
    expect(byQ.get('t002')).toMatchObject({ outcome: 'recommend', recommendation: { option: 'later' } });
    expect(byQ.get('t005')).toMatchObject({ outcome: 'abstain', fallback: { used: false, option: 'later' } });
    for (const r of results) {
      expect(r.record.batch?.size).toBeGreaterThan(1);
      expect(Object.keys(r.record.distribution ?? {}).sort()).toEqual(['later', 'needs_review', 'next']);
    }
    // the same batch again: every task's decision is returned, with no call
    const again = await decideBatch(queue(), { settings: ON, provider, fixture: answerFile() });
    expect(again.every((r) => r.reused)).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(records()).toHaveLength(100);
  });

  it('a batch with a task decided already asks only for the rest', async () => {
    const { calls, provider } = counted();
    const file = answerFile();
    await decideBatch(queue().slice(0, 10), { settings: ON, provider, fixture: file });
    expect(calls).toHaveLength(1);
    const rest = await decideBatch(queue(), { settings: ON, provider, fixture: file });
    expect(rest.filter((r) => r.reused)).toHaveLength(10);
    const askedSecond = calls.slice(1).flatMap((c) => Object.keys(c.questions).filter((q) => q !== 'human_review'));
    expect(askedSecond).toHaveLength(90);
    expect(askedSecond).not.toContain('t001');
    expect(records()).toHaveLength(100);
  });
});
