/**
 * R5 (H137): what Timmy Studio's workspace strip shows of a frame (companion/studio-canvas/src/frame.js frameView, eventsOf), pure:
 * the frame's log and its sealed chat turns merged as the companion merges them (src/companion/client/companion.js eventsOf: a
 * turn is an entry tagged chat, its receipt the source, the failure tone when it failed), the newest first, at most LOG_MAX for
 * the open activity, the collapsed line's newest the merge's newest; a chat turn being answered named on the line; the one
 * primary action first in reading order with the number the frame gave it. The frames here are FAKE (written by this test).
 */
import { describe, expect, it } from 'vitest';
import { eventsOf, frameView, LOG_MAX } from '../companion/studio-canvas/src/frame.js';

const at = (s: number): string => new Date(Date.UTC(2026, 9, 15, 20, 0, s)).toISOString();
/** A FAKE frame of the strip's schema with `o` over it. */
const frame = (o: Record<string, unknown> = {}) => ({
  schema: 'timmy.workspace/1', revision: 'r1', project: { name: 'demo', shown: '~/demo' }, tabs: [{ id: 'studio', key: '4', label: 'Studio', waiting: 0 }],
  actions: { studio: [
    { n: 1, label: 'Open Studio', command: '/studio', primary: false },
    { n: 2, label: 'Ask Timmy to draw', command: '/canvas open', primary: true },
    { n: 3, label: 'Show the board', command: '/board', primary: false },
  ] },
  activity: { running: 0, waitingOnYou: 0, stopCurrent: { job: null, words: 'Stop current: idle' } },
  log: [], unknown: [], ...o,
});
const logEntry = (s: number, words: string, tone = 'neutral') => ({ at: at(s), tag: 'job', words: `FAKE ${words}`, tone, source: 'job j1' });
const turn = (s: number, receipt: string, state: string, operation: string | null = null) => ({
  receipt, surface: 'repl', state, model: 'FAKE-model', at: at(s), operation, route: 'openrouter', words: `FAKE turn ${state} in the REPL · receipt ${receipt}`,
});

describe("the Studio strip's view of a frame (R5 H137)", () => {
  it('merges the log and the sealed chat turns, the newest first, as the companion does: a turn tagged chat, its receipt the source, failed in the failure tone', () => {
    const f = frame({ log: [logEntry(30, 'job ended'), logEntry(10, 'job started')], chat: { turns: [turn(40, 'aaaa0001', 'failed', 'o1234abcd'), turn(20, 'bbbb0002', 'answered')] } });
    const merged = eventsOf(f);
    expect(merged.map((e) => [e.at, e.tag, e.words, e.tone, e.source, e.operation])).toEqual([
      [at(40), 'chat', 'FAKE turn failed in the REPL · receipt aaaa0001', 'failure', 'receipt aaaa0001', 'o1234abcd'],
      [at(30), 'job', 'FAKE job ended', 'neutral', 'job j1', ''],
      [at(20), 'chat', 'FAKE turn answered in the REPL · receipt bbbb0002', 'neutral', 'receipt bbbb0002', ''],
      [at(10), 'job', 'FAKE job started', 'neutral', 'job j1', ''],
    ]);
    const v = frameView(f)!;
    // the collapsed line's newest is the merge's newest (a failed turn, in the failure tone), and the open activity lists them all
    expect(v.activity.newest).toMatchObject({ words: 'FAKE turn failed in the REPL · receipt aaaa0001', tone: 'failure', tag: 'chat' });
    expect(v.log.map((e) => e.at)).toEqual([at(40), at(30), at(20), at(10)]);
    expect(v.log.every((e) => /^\d\d:\d\d:\d\d$/.test(e.clock))).toBe(true);
  });

  it(`lists at most ${LOG_MAX} entries, the newest; a frame without turns or log says so`, () => {
    const log = Array.from({ length: 6 }, (_, i) => logEntry(i * 2, `entry ${i}`));
    const turns = Array.from({ length: 6 }, (_, i) => turn(i * 2 + 1, `cccc000${i}`, 'answered'));
    const v = frameView(frame({ log, chat: { turns } }))!;
    expect(LOG_MAX).toBe(8);
    expect(v.log).toHaveLength(8);
    expect(v.log.map((e) => e.at)).toEqual([11, 10, 9, 8, 7, 6, 5, 4].map(at));
    const empty = frameView(frame({ unknown: [{ field: 'log', why: 'no job has run in this project yet' }] }))!;
    expect(empty.log).toEqual([]);
    expect(empty.activity.newest).toBeNull();
    expect(empty.activity.noLog).toBe('no job has run in this project yet');
    // a frame from before the chat turns (no `chat`) still draws its log
    expect(frameView(frame({ log: [logEntry(5, 'only')] }))!.log.map((e) => e.words)).toEqual(['FAKE only']);
  });

  it('names a chat turn being answered now on the line, as the frame words it', () => {
    const v = frameView(frame({ activity: { running: 1, waitingOnYou: 0, stopCurrent: { job: null, words: 'Stop current: the chat turn in the Workbench (Esc in its composer)' }, chatTurn: { surface: 'workbench', since: at(1), words: 'a chat turn is being answered in the Workbench (since 20:00:01 UTC)' } } }))!;
    expect(v.activity.turn).toBe('a chat turn is being answered in the Workbench (since 20:00:01 UTC)');
    expect(v.activity.running).toBe(1);
    expect(frameView(frame())!.activity.turn).toBe('');
  });

  it('puts the one primary first in reading order, keeping the number the frame gave it; a second primary is an ordinary action', () => {
    const v = frameView(frame())!;
    expect(v.actions.map((a) => [a.n, a.label, a.primary])).toEqual([[2, 'Ask Timmy to draw', true], [1, 'Open Studio', false], [3, 'Show the board', false]]);
    const two = frameView(frame({ actions: { studio: [{ n: 1, label: 'A', command: '/a', primary: true }, { n: 2, label: 'B', command: '/b', primary: true }] } }))!;
    expect(two.actions.filter((a) => a.primary).map((a) => a.n)).toEqual([1]);
  });
});
