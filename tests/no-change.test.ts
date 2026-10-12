/**
 * Round R4 (H99, r24): "no change" as its own outcome, layer by layer, without processes: the tray's last-build check (its
 * edge cases through its labelled FAKE readers), a flow record's outcome as an operation counts it, the operation's state
 * and `timmy act`'s exit, a block whose own flows made no change, and a /run that stopped there, as /jobs, the Control
 * Room's judge and every block view read it.
 *
 * On the Mac (r24) a satisfied request run again ("make the tray 150 mm wide" after it was 150) ended with the agent
 * changing nothing: the flow said 'stopped', its block exited 1, and the job, the card, /room and God's Eye View said
 * FAILED. These tests hold each layer to the new words.
 */
import { describe, expect, it } from 'vitest';
import { trayLastBuild, type TrayLastBuildDeps } from '../src/flows/iterate.js';
import { flowOutcome, jobOutcome } from '../src/ops/outcome.js';
import { decideState } from '../src/ops/operations.js';
import { exitCodeOf } from '../src/ops/act.js';
import { blockOutcome, NO_CHANGE_EXIT, noChangeWords } from '../src/workflows/block-receipts.js';
import { runBlocks } from '../src/workflows/run-blocks.js';
import { blockCount, blockCountLine } from '../src/workflows/block-count.js';
import { jobJudgement, markGlyph } from '../src/room/judge.js';
import type { JobRecord, JobStep } from '../src/jobs/index.js';

const NOW = () => new Date('2026-10-11T12:00:00Z');
const UUID = '11111111-2222-4333-8444-555555555555';
const NEWER = '99999999-2222-4333-8444-555555555555';
const VALUES = { width: 150, wall: 3, supportOffset: 10, bore: 3 };

/** FAKE readers for trayLastBuild: a recipe job built from `built`, sources that hash as given, a copy that checks or not. */
function fakeDeps(o: { built?: Record<string, number>; jobs?: TrayLastBuildDeps['list'] extends (r: string) => infer R ? R : never; sourceNow?: string | null; copy?: boolean; throws?: boolean } = {}): TrayLastBuildDeps {
  const built = o.built ?? VALUES;
  const hashOf = (v: Record<string, number>): string => `req:${v.width}:${v.wall}:${v.supportOffset}:${v.bore}`;
  return {
    list: () => { if (o.throws) throw new Error('FAKE: unreadable'); return o.jobs ?? [{ id: UUID, created: Date.parse('2026-10-11T10:00:00Z'), state: 'succeeded', resultHash: 'r'.repeat(64) }]; },
    load: () => ({ request: { parameters: built }, requestHash: hashOf(built), sources: [{ file: '/somewhere/outside/build.py', hash: 'a'.repeat(64) }, { file: '/somewhere/outside/tray.ts', hash: 'b'.repeat(64) }] }),
    request: (v) => ({ sha256: hashOf(v), parameters: v }),
    hashFile: (abs) => (abs.endsWith('build.py') ? (o.sourceNow === undefined ? 'a'.repeat(64) : o.sourceNow) : 'b'.repeat(64)),
    copy: () => (o.copy === false ? { ok: false, error: 'out/recipes/11111111/console-tray.step differs from the verified result' } : { ok: true }),
  };
}

describe('the tray\'s last build, checked when a flow made no change (FAKE readers)', () => {
  it('current only when the request, every recorded source and the exports all check', () => {
    const lb = trayLastBuild('/p', VALUES, { now: NOW, deps: fakeDeps() });
    expect(lb.state).toBe('current');
    expect(lb.words).toBe('the last build (recipe job 11111111, 2026-10-11 10:00 UTC) still matches its recorded inputs: its request is the parameter file\'s values (width 150, wall 3, supportOffset 10, bore 3), its 2 source files hash as recorded, and its exports in out/recipes/11111111/ are the bytes its signed result names');
    expect(lb.checks.map((c) => c.what)).toEqual(['the request (the parameter values it was built from)', 'source build.py', 'source tray.ts', 'its exports in out/recipes/11111111/']);
    // a source outside the project is named by its file name only
    expect(JSON.stringify(lb)).not.toContain('/somewhere');
    expect(lb.checked_at).toBe('2026-10-11T12:00:00.000Z');
  });
  it('stale when the values differ, naming both', () => {
    const lb = trayLastBuild('/p', { ...VALUES, width: 160 }, { now: NOW, deps: fakeDeps() });
    expect(lb.state).toBe('stale');
    expect(lb.words).toBe('the last build (recipe job 11111111, 2026-10-11 10:00 UTC) is stale: it was built from width 150, and the parameter file holds width 160 now; /recipe tray rebuilds it from the file');
  });
  it('stale when a recorded source changed since, or is gone', () => {
    expect(trayLastBuild('/p', VALUES, { now: NOW, deps: fakeDeps({ sourceNow: 'c'.repeat(64) }) }).words).toContain('is stale: its source build.py has changed since (sha256 aaaaaaaa then, cccccccc now)');
    expect(trayLastBuild('/p', VALUES, { now: NOW, deps: fakeDeps({ sourceNow: null }) }).words).toContain('is stale: its source build.py is not there now');
  });
  it('stale when its exports in the project are not the bytes its signed result names', () => {
    const lb = trayLastBuild('/p', VALUES, { now: NOW, deps: fakeDeps({ copy: false }) });
    expect(lb.state).toBe('stale');
    expect(lb.words).toContain('its exports in the project are not the bytes its signed result names (out/recipes/11111111/console-tray.step differs from the verified result)');
  });
  it('unknown while a newer build has not ended; none when nothing succeeded; unknown when the jobs cannot be read', () => {
    const running = trayLastBuild('/p', VALUES, { now: NOW, deps: fakeDeps({ jobs: [{ id: NEWER, created: 3, state: 'running' }, { id: UUID, created: 2, state: 'succeeded' }] }) });
    expect(running).toMatchObject({ state: 'unknown', build: { id: UUID } });
    expect(running.words).toBe('whether the last build still matches its inputs is not known: a newer build (recipe job 99999999) has not ended (running); /recipe jobs follows it');
    const none = trayLastBuild('/p', VALUES, { now: NOW, deps: fakeDeps({ jobs: [{ id: NEWER, created: 3, state: 'failed' }] }) });
    expect(none).toMatchObject({ state: 'none', words: 'there is no build of the tray in this project yet (1 recipe job, none succeeded): /recipe tray builds it from recipes/tray.params.json' });
    expect(trayLastBuild('/p', VALUES, { now: NOW, deps: fakeDeps({ throws: true }) })).toMatchObject({ state: 'unknown', words: 'whether the last build still matches its inputs is not known: the recipe jobs could not be read (FAKE: unreadable)' });
  });
});

describe('a flow that made no change, as an operation counts it, and `timmy act`\'s exit', () => {
  const flow = (state: string) => ({ id: 'f12345678', outcome: 'no change', ended_in: 'checks', why: 'no change: the agent changed nothing, so nothing was rebuilt; …', last_build: { state, words: `the last build is ${state}` }, agent: { run: 'a12345678', job: 'j123456' } });
  it('its run outcome: no change, with its last build\'s words and whether it is current', () => {
    expect(flowOutcome(flow('current'))).toEqual({ state: 'no change', words: 'no change: the last build is current', claims: expect.arrayContaining(['agent:a12345678', 'job:j123456']), current: true });
    expect(flowOutcome(flow('stale')).current).toBe(false);
    expect(flowOutcome({ outcome: 'no change' })).toMatchObject({ state: 'no change', words: 'no change: its record does not say whether the last build still matches', current: false });
  });
  it('the operation\'s state: no change (never succeeded), current only when every such run found its build current', () => {
    const run = (id: string) => ({ kind: 'flow' as const, id, at: '' });
    const current = decideState([{ run: run('f1'), out: flowOutcome(flow('current')) }]);
    expect(current).toMatchObject({ state: 'no change', current: true });
    expect(current.why).toBe('flow f1 no change: the last build is current');
    expect(decideState([{ run: run('f1'), out: flowOutcome(flow('current')) }, { run: run('f2'), out: flowOutcome(flow('stale')) }])).toMatchObject({ state: 'no change', current: false });
    // a run that made no change ranks before a success; a failure before it
    expect(decideState([{ run: run('f1'), out: flowOutcome(flow('current')) }, { run: { kind: 'vox', id: 'v1', at: '' }, out: { state: 'succeeded', words: 'ok' } }]).state).toBe('no change');
    expect(decideState([{ run: run('f1'), out: flowOutcome(flow('current')) }, { run: { kind: 'vox', id: 'v1', at: '' }, out: { state: 'failed', words: 'failed' } }]).state).toBe('failed');
  });
  it('the exit: 0 when the last build is current (the blocks that need it run on it), else NO_CHANGE_EXIT (4); the others as before', () => {
    expect(NO_CHANGE_EXIT).toBe(4);
    expect(exitCodeOf('no change', true)).toBe(0);
    expect(exitCodeOf('no change', false)).toBe(4);
    expect(exitCodeOf('no change', undefined)).toBe(4);
    expect([exitCodeOf('succeeded'), exitCodeOf('answered'), exitCodeOf('failed'), exitCodeOf('differs'), exitCodeOf('refused'), exitCodeOf('stopped')]).toEqual([0, 0, 1, 1, 2, 3]);
  });
});

describe('a /run block whose own flows made no change, and a run that stopped there', () => {
  const nc = [{ id: 'f12345678', outcome: 'no change', why: 'no change: the agent changed nothing, so nothing was rebuilt; the last build (recipe job 11111111) is stale: …' }];
  it('the block\'s outcome: no change only with its flows\' word and the exit `timmy act` gives such a request (0, or 4)', () => {
    expect(blockOutcome({ state: 'completed', code: 0 }, nc)).toBe('no change');
    expect(blockOutcome({ state: 'failed', code: NO_CHANGE_EXIT }, nc)).toBe('no change');
    expect(blockOutcome({ state: 'failed', code: 1 }, nc)).toBe('failed'); // another exit: the block failed for its own reason
    expect(blockOutcome({ state: 'failed', code: 4 }, [])).toBe('failed'); // an exit alone never decides it
    expect(blockOutcome({ state: 'completed', code: 0 }, [...nc, { id: 'f2', outcome: 'succeeded' }])).toBe('completed');
    expect(noChangeWords(nc)).toBe('flow f12345678: the agent changed nothing, so nothing was rebuilt; the last build (recipe job 11111111) is stale: …');
  });
  const steps: JobStep[] = [{ name: 'change', state: 'failed', code: 4, outcome: 'no change', why: 'flow f12345678: the agent changed nothing, so nothing was rebuilt; the last build is stale' }];
  const job = { id: 'j123456', kind: 'workflow', label: 'WORKFLOW.md › result', state: 'failed', steps, args: [], expected: { steps: ['change', 'inspect', 'result'] }, startedAt: '2026-10-11T10:00:00Z', exitCode: 4 } as unknown as JobRecord;
  it('its blocks: "no change" (never failed), then the blocks it stopped "not run"; counted against the order: 1 of 3 steps', () => {
    expect(runBlocks(job, ['change', 'inspect', 'result']).map((b) => b.word)).toEqual(['no change', 'not run', 'not run']);
    expect(runBlocks(job, ['change'])[0].why).toContain('the last build is stale');
    const count = blockCount(job);
    expect(blockCountLine(count)).toBe('1 of 3 steps; change no change, exit 4; inspect, result not run');
  });
  it('its job: judged "no change" and marked = (never ✖), and as its operation counts it: no change, not current', () => {
    const j = jobJudgement(job);
    expect(j).toMatchObject({ kind: 'workflow', by: 'exit', mark: 'unchanged', word: 'no change' });
    expect(markGlyph(j.mark, { ok: '✓', fail: '✖', bullet: '●' })).toBe('=');
    expect(jobOutcome(job)).toMatchObject({ state: 'no change', current: false });
    expect(jobOutcome(job).words).toBe('stopped at change, which made no change: flow f12345678: the agent changed nothing, so nothing was rebuilt; the last build is stale');
    // a block that failed for another reason beside it: failed, as before
    const both = { ...job, steps: [...steps, { name: 'other', state: 'failed', code: 1 }] } as JobRecord;
    expect(jobJudgement(both).mark).toBe('failed');
    // a run that completed with a block that made no change: completed (each block exited 0), the block named
    const done = { ...job, state: 'completed', exitCode: 0, steps: [{ ...steps[0], state: 'completed', code: 0 }, { name: 'inspect', state: 'completed', code: 0 }, { name: 'result', state: 'completed', code: 0 }] } as JobRecord;
    expect(jobJudgement(done)).toMatchObject({ mark: 'ok', word: 'completed' });
    expect(jobOutcome(done)).toEqual({ state: 'succeeded', words: 'completed; change: no change' });
    expect(blockCountLine(blockCount(done))).toBe('3 of 3 steps; change no change');
  });
});
