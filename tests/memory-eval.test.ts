/**
 * Timmy Memory (round R4, helper H50): /lesson eval, an evaluated improvement and not training, over hand-made flow
 * records (written by the flows' own writer, with made-up contents: no flow ran) in a temporary project with a REAL
 * receipts chain (tests/helpers/memory-kit.ts). It compares the runs of the lesson's kinds that did not use it, before its
 * first use, with the runs that used it, from the flow records only; unknown costs stay unknown, never 0; with fewer than
 * 5 runs on either side it says "too few runs to compare"; it never claims significance.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLesson, sideOf } from '../src/memory/eval.js';
import { LESSONS_ARE, type Lesson } from '../src/memory/lessons.js';
import { memoryKit, put, read, text, workspace, writeFlow } from './helpers/memory-kit.js';

const kit = memoryKit();
afterEach(async () => { await kit.cleanup(); });

const T = (min: number): string => new Date(Date.parse('2026-10-01T00:00:00Z') + min * 60_000).toISOString();

function project() {
  const root = kit.temp('memory-eval-');
  put(root, 'evidence/one.txt', 'x\n');
  const { ws } = workspace(root, kit);
  const id = /Lesson\s+(l[0-9a-f]{8})/.exec(text(ws.lesson('add "A 0.4 mm lid gap fits." --from evidence/one.txt --applies scad')))![1];
  return { root, ws, id };
}

describe('/lesson eval: the flows without the lesson (before its first use) beside the flows with it', () => {
  it('counts n, completion, correctness, median duration, cost with unknowns kept apart, interventions and recovery; too few runs; no significance', () => {
    const { root, ws, id } = project();
    // Without it, before its first use (minute 100): 4 scad flows.
    writeFlow(root, { kind: 'scad', instruction: 'a', started: T(0), ended: T(2), outcome: 'succeeded', verdict: 'matches', cost: 0 });
    writeFlow(root, { kind: 'scad', instruction: 'b', started: T(10), ended: T(14), outcome: 'differs', verdict: 'differs', cost: null });
    writeFlow(root, { kind: 'scad', instruction: 'c', started: T(20), ended: T(21), outcome: 'cancelled', verdict: null });
    writeFlow(root, { kind: 'scad', instruction: 'd', started: T(30), ended: T(36), outcome: 'succeeded', verdict: 'matches', cost: 0.25 });
    // Not counted: another kind, and a scad flow without it after its first use.
    writeFlow(root, { kind: 'tray', instruction: 'e', started: T(40), outcome: 'failed', verdict: null });
    writeFlow(root, { kind: 'scad', instruction: 'f', started: T(200), outcome: 'failed', verdict: null });
    // With it: 3 scad flows, one of them interrupted and recorded by recovery, one with an unknown cost.
    writeFlow(root, { kind: 'scad', instruction: 'g', started: T(100), ended: T(103), outcome: 'succeeded', verdict: 'matches', cost: 0, lessons: [id] });
    writeFlow(root, { kind: 'scad', instruction: 'h', started: T(110), ended: T(115), outcome: 'succeeded', verdict: 'matches', cost: null, lessons: [id] });
    writeFlow(root, { kind: 'scad', instruction: 'i', started: T(120), ended: T(121), outcome: 'interrupted', verdict: null, lessons: [id], recovered: true });
    put(root, 'results/flows/f00000bad.json', '{ not a record');

    const lesson = JSON.parse(read(root, `.timmy/memory/lessons/${id}.json`)) as Lesson;
    const e = evaluateLesson(root, lesson);
    expect(e.kinds).toEqual(['scad']);
    expect(e.firstUse).toBe(T(100));
    expect(e.without).toMatchObject({ n: 4, succeeded: 2, compared: 3, matched: 2, timed: 4, costUsd: 0.25, costRecorded: 2, costUnknown: 1, costNone: 1, interventions: 1, recovered: 0 });
    expect(e.without.medianMs).toBe(3 * 60_000); // 1, 2, 4, 6 minutes
    expect(e.with).toMatchObject({ n: 3, succeeded: 2, compared: 2, matched: 2, costUsd: 0, costRecorded: 1, costUnknown: 1, costNone: 1, interventions: 0, recovered: 1 });
    expect(e.with.medianMs).toBe(3 * 60_000); // 1, 3, 5 minutes
    expect(e.tooFew).toBe(true);
    expect(e.unreadable.map((u) => u.rel)).toEqual(['results/flows/f00000bad.json']);

    const out = text(ws.lesson(`eval ${id}`));
    expect(out).toContain('from the flow records only: scad flows that did not use it (started before its first use, 2026-10-01T01:40:00.000Z), beside the flows that used it');
    expect(out).toMatch(/runs \(n\) +4 {2}│ {2}3/);
    expect(out).toMatch(/completion +2 of 4 \(50%\) succeeded {2}│ {2}2 of 3 \(67%\) succeeded/);
    expect(out).toMatch(/correctness +2 of 3 \(67%\) readbacks matched {2}│ {2}2 of 2 \(100%\) readbacks matched/);
    expect(out).toMatch(/duration +median 3 min over 4 runs {2}│ {2}median 3 min over 3 runs/);
    expect(out).toContain('$0.2500 recorded over 2 runs; 1 unknown (not counted as 0); 1 with no cost recorded');
    expect(out).toContain('$0.0000 recorded over 1 run; 1 unknown (not counted as 0); 1 with no cost recorded');
    expect(out).toMatch(/interventions +1 stopped by a person {2}│ {2}0 stopped by a person/);
    expect(out).toMatch(/recovery +0 interrupted and recorded by recovery {2}│ {2}1 interrupted and recorded by recovery/);
    expect(out).toContain('too few runs to compare: 4 without and 3 with (5 or more on each side are needed)');
    expect(out).toContain('No significance is claimed either way');
    expect(out).toContain('Not counted: 1 flow record that could not be read (results/flows/f00000bad.json:');
    expect(out).toContain(LESSONS_ARE);
    expect(out).not.toMatch(/significant(?!ce is claimed)/);
  });

  it('5 or more on each side: the numbers stand without "too few runs"; a lesson never used compares nothing with it', () => {
    const { root, ws, id } = project();
    for (let i = 0; i < 5; i++) writeFlow(root, { kind: 'scad', instruction: `before ${i}`, started: T(i), ended: T(i + 1), outcome: 'succeeded', verdict: 'matches', cost: 0 });
    const lesson = JSON.parse(read(root, `.timmy/memory/lessons/${id}.json`)) as Lesson;
    const unused = evaluateLesson(root, lesson);
    expect(unused.firstUse).toBeUndefined();
    expect([unused.without.n, unused.with.n, unused.tooFew]).toEqual([5, 0, true]);
    expect(text(ws.lesson(`eval ${id}`))).toContain('(it has not been used yet)');
    for (let i = 0; i < 5; i++) writeFlow(root, { kind: 'scad', instruction: `with ${i}`, started: T(100 + i), ended: T(102 + i), outcome: 'succeeded', verdict: 'matches', cost: 0, lessons: [id] });
    const e = evaluateLesson(root, lesson);
    expect([e.without.n, e.with.n, e.tooFew]).toEqual([5, 5, false]);
    const out = text(ws.lesson(`eval ${id}`));
    expect(out).not.toContain('too few runs to compare');
    expect(out).toContain('No significance is claimed either way');
  });

  it('a lesson for kinds with no flow records says they are not compared here', () => {
    const { root, ws } = project();
    const id = /Lesson\s+(l[0-9a-f]{8})/.exec(text(ws.lesson('add "Agents read the README first." --from evidence/one.txt --applies agent vox')))![1];
    const out = text(ws.lesson(`eval ${id}`));
    expect(out).toContain('it names no flow kind and no flow used it, so there are no flows to set beside each other');
    expect(out).toContain('not compared: agent, vox (no flow records; /agent runs, VoxVision actions and workflow runs are not counted here)');
    expect(sideOf([])).toMatchObject({ n: 0, medianMs: null });
    void root;
  });
});
