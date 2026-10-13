/**
 * R4 (H109): how Timmy Canvas's side panel lays out an operation's run detail (companion/studio-canvas/src/run-detail.js
 * runDetailSections, durationWords), run here in Node; the panel itself runs in a real Chromium in
 * tests/studio-run-detail-browser.test.ts. The run details below are FIXTURES in the shape of src/contracts/run-detail.ts
 * (what src/ops/run-detail.ts makes; this page never makes one), their words labelled FIXTURE.
 */
import { describe, expect, it } from 'vitest';
import { RUN_DETAIL_VERSION, type RunDetail } from '../src/contracts/run-detail.js';
// @ts-expect-error: the page's module is plain JavaScript, bundled for the browser
import { durationWords, runDetailSections } from '../companion/studio-canvas/src/run-detail.js';

type Row = { label: string; value: string; from: string | null; command: string | null };
type Section = { title: string; rows: Row[] };

const OP = 'oa1b2c3d4';
/** A FIXTURE run detail as the server sends it (the project's folder as "."). */
function fixture(over: Partial<RunDetail> = {}): RunDetail {
  return {
    version: RUN_DETAIL_VERSION, operation: OP, parent: null, children: [],
    project: { name: 'demo', root: '.', id: 'a'.repeat(16) },
    objective: { value: 'FIXTURE: make the tray 150 mm wide', from: `.timmy/operations/${OP}.json` },
    sourceRevision: null,
    verdict: { state: 'completed', words: 'FIXTURE: the tray was rebuilt and its readback matches', from: 'receipt 1a2b3c4d' },
    stage: { current: 'readback', done: 3, total: 3, from: 'results/flows/fa1b2c3d4.json' },
    exits: [{ who: 'recipe runner', code: 0, state: 'exited', from: 'jobs/j1.json' }, { who: 'upmd', code: 2, from: 'jobs/j2.json' }],
    freshness: { state: 'current', why: 'FIXTURE: its inputs hold the bytes it was built from', from: 'results/flows/fa1b2c3d4.json' },
    acceptance: { state: 'not reviewed' },
    worker: { harness: { value: 'FIXTURE harness', from: 'jobs/j1.json' } },
    time: { startedAt: '2026-10-11T10:00:00.000Z', endedAt: '2026-10-11T10:02:05.000Z', elapsedMs: 125_000 },
    prediction: { words: 'FIXTURE: 150 x 80 x 30 mm', receipt: '0f0e0d0c', frozenAt: '2026-10-11T09:59:59.000Z' },
    checks: [{ name: 'bounds', predicted: '150 x 80 x 30 mm', actual: '150 x 80 x 30 mm', differs: false, from: 'receipt 1a2b3c4d' }],
    files: [{ path: './recipes/tray.params.json', role: 'input', sha256: 'ab'.repeat(32), from: 'receipt 1a2b3c4d' }],
    receipts: [{ id: '1a2b3c4d', kind: 'flow', subject: 'tray' }],
    cost: { usd: null, measured: false, why: 'FIXTURE: no model was called, so no cost was reported' },
    summary: { path: null },
    next: { words: 'FIXTURE: look at the tray, then accept or reject it', command: `/op ${OP}` },
    unknown: [{ field: 'sourceRevision', why: 'FIXTURE: no record names the revision it started from' }],
    ...over,
  };
}
const sections = (d: unknown): Section[] => runDetailSections(d) as Section[];
const section = (d: unknown, title: string): Section | undefined => sections(d).find((s) => s.title === title);
const row = (d: unknown, title: string, label: string): Row | undefined => section(d, title)?.rows.find((r) => r.label === label);

describe("an operation's run detail, as the side panel lays it out", () => {
  it('keeps the verdict, the stage, each exit, the freshness and a person\'s acceptance on rows of their own, each with its record; a nonzero exit is shown as it is, never as the verdict', () => {
    const d = fixture();
    expect(sections(d).map((s) => s.title)).toEqual(['Operation', 'State, each kept apart', 'Worker and time', 'Prediction and checks', 'Files and receipts', 'Cost', 'Next', 'Not known']);
    const state = section(d, 'State, each kept apart')!.rows;
    expect(state.map((r) => r.label)).toEqual(["Timmy's verdict", 'workflow stage', 'exit of recipe runner', 'exit of upmd', 'artifact freshness', "a person's acceptance"]);
    expect(state.map((r) => r.value)).toEqual([
      'completed: FIXTURE: the tray was rebuilt and its readback matches',
      'readback · 3 of 3 steps done',
      'exit 0 (exited)',
      'exit 2',
      'current: FIXTURE: its inputs hold the bytes it was built from',
      'not reviewed',
    ]);
    expect(state.map((r) => r.from)).toEqual(['receipt 1a2b3c4d', 'results/flows/fa1b2c3d4.json', 'jobs/j1.json', 'jobs/j2.json', 'results/flows/fa1b2c3d4.json', null]);
    expect(row(d, 'Operation', 'request')).toEqual({ label: 'request', value: 'FIXTURE: make the tray 150 mm wide', from: `.timmy/operations/${OP}.json`, command: null });
    expect(row(d, 'Operation', 'source revision')!.value).toBe('not recorded');
    expect(row(d, 'Next', 'next')).toMatchObject({ value: 'FIXTURE: look at the tray, then accept or reject it', command: `/op ${OP}` });
    expect(row(d, 'Not known', 'sourceRevision')!.value).toBe('FIXTURE: no record names the revision it started from');
  });

  it('says a cost only as the reported number (with its record), else unknown and why: never an invented 0; nothing anywhere is a percentage', () => {
    const unknown = fixture();
    expect(row(unknown, 'Cost', 'cost')).toEqual({ label: 'cost', value: 'unknown: FIXTURE: no model was called, so no cost was reported', from: null, command: null });
    const measured = fixture({ cost: { usd: 0.42, measured: true, from: 'receipt 5e6f7a8b' } });
    expect(row(measured, 'Cost', 'cost')).toMatchObject({ value: '$0.42', from: 'receipt 5e6f7a8b' });
    // a cost that says it was measured but holds no number is not shown as one
    expect(row(fixture({ cost: { usd: null, measured: true } as never }), 'Cost', 'cost')!.value).toBe('unknown');
    for (const d of [unknown, measured]) {
      const all = sections(d).flatMap((s) => s.rows.flatMap((r) => [r.label, r.value, r.from ?? '']));
      expect(all.filter((t) => t.includes('%'))).toEqual([]);
      expect(all.filter((t) => /\$0(?!\.)/.test(t))).toEqual([]);
    }
  });

  it('says what no record holds in words (an unknown total of steps, no exit code, no prediction, no worker, nothing next), and leaves out a section with nothing in it', () => {
    const d = fixture({
      stage: { current: null, done: 1, total: null, from: 'jobs/j1.json' },
      exits: [{ who: 'agent', code: null, state: 'killed', from: 'jobs/j3.json' }],
      prediction: null,
      checks: [{ name: 'width', predicted: null, actual: '151 mm', differs: true, from: 'receipt 1a2b3c4d' }],
      worker: {},
      next: null,
      unknown: [],
      acceptance: { state: 'accepted', by: 'operator', at: '2026-10-11T11:00:00.000Z', from: 'receipt 9f8e7d6c' },
      time: { startedAt: '2026-10-11T10:00:00.000Z', endedAt: null, elapsedMs: null },
    });
    expect(row(d, 'State, each kept apart', 'workflow stage')!.value).toBe('1 of an unknown number of steps done');
    expect(row(d, 'State, each kept apart', 'exit of agent')!.value).toBe('no exit code (killed)');
    expect(row(d, 'State, each kept apart', "a person's acceptance")).toMatchObject({ value: 'accepted by operator at 2026-10-11T11:00:00.000Z', from: 'receipt 9f8e7d6c' });
    expect(row(d, 'Prediction and checks', 'prediction')!.value).toBe('none recorded');
    expect(row(d, 'Prediction and checks', 'width')!.value).toBe('actual 151 mm (differs)');
    expect(section(d, 'Worker and time')!.rows.map((r) => `${r.label}: ${r.value}`)).toEqual(['model: not recorded', 'harness: not recorded', 'environment: not recorded', 'started: 2026-10-11T10:00:00.000Z', 'ended: not ended', 'time: not recorded']);
    expect(row(d, 'Next', 'next')!.value).toBe('none named');
    expect(section(d, 'Not known')).toBeUndefined();
    expect(row(d, 'Files and receipts', 'summary')!.value).toBe('no summary saved beside the records');
    // nothing to lay out is not an error
    expect(() => sections(null)).not.toThrow();
    expect(row(null, 'Cost', 'cost')!.value).toBe('unknown');
  });

  it('gives a time in words, never a percentage of anything', () => {
    expect(durationWords(850)).toBe('850 ms');
    expect(durationWords(12_340)).toBe('12.3 s');
    expect(durationWords(125_000)).toBe('2 min 5 s');
    expect(durationWords(3_723_000)).toBe('1 h 2 min');
    expect(durationWords(null)).toBe('not recorded');
    expect(durationWords(-1)).toBe('not recorded');
    expect(durationWords(Number.NaN)).toBe('not recorded');
  });
});
