/**
 * R5 (H137): what Timmy Studio's workspace strip shows of a frame (companion/studio-canvas/src/frame.js frameView, eventsOf), pure:
 * the frame's log and its sealed chat turns merged as the companion merges them (src/companion/client/companion.js eventsOf: a
 * turn is an entry tagged chat, its receipt the source, the failure tone when it failed), the newest first, at most LOG_MAX for
 * the open activity, the collapsed line's newest the merge's newest; a chat turn being answered named on the line; the one
 * primary action first in reading order with the number the frame gave it. The frames here are FAKE (written by this test).
 */
import { describe, expect, it } from 'vitest';
import { DRAFT_STEP, eventsOf, FRAME_EVERY_MS, FRAME_FAST_MS, frameView, isDraftStep, LOG_MAX, nextReadMs } from '../companion/studio-canvas/src/frame.js';
import { TABS } from '../src/contracts/workspace.js';
import { actionsOf } from '../src/ops/workspace-frame.js';
import { saveState } from '../companion/studio-canvas/src/save-state.js';
import { clockOf, dateTimeOf } from '../companion/studio-canvas/src/when.js';

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

  it('names a chat turn being answered now on the line, as the frame words it, with since when in the one time format; Stop current is the frame\'s words', () => {
    const v = frameView(frame({ activity: { running: 1, waitingOnYou: 0, stopCurrent: { job: null, words: 'Stop current: the chat turn in the Workbench (Esc in its composer)' }, chatTurn: { surface: 'workbench', since: at(1), words: 'a chat turn is being answered in the Workbench', id: 't1-0000abcd' } } }))!;
    expect(v.activity.turn).toBe('a chat turn is being answered in the Workbench');
    // the frame's words carry no clock time (the lead's 0f9f8cb): the strip says since when, in this computer's 24-hour clock
    expect(v.activity.turnSince).toBe(clockOf(at(1)));
    expect(v.activity.turnSince).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(v.activity.stop).toEqual({ job: null, words: 'Stop current: the chat turn in the Workbench (Esc in its composer)' });
    expect(v.activity.running).toBe(1);
    const idle = frameView(frame({ activity: { running: 0, waitingOnYou: 0, stopCurrent: { job: null, words: '' } } }))!;
    expect([idle.activity.turn, idle.activity.turnSince, idle.activity.stop.words]).toEqual(['', '', '']);
  });

  it('R5 (H137; the QA round, defect 6): one time format, as the terminal Workbench and the companion show it: the 24-hour clock in this computer\'s local time, with the date where a time can be another day\'s; nothing for no time', () => {
    const local = new Date(2026, 9, 15, 9, 5, 7);
    expect(clockOf(local)).toBe('09:05:07');
    expect(clockOf(local.toISOString())).toBe('09:05:07');
    expect(dateTimeOf(local)).toBe('2026-10-15 09:05:07');
    expect(clockOf(new Date(2026, 9, 15, 21, 18, 36))).toBe('21:18:36');
    for (const nothing of ['', 'not a time', undefined]) {
      expect(clockOf(nothing as unknown as string)).toBe('');
      expect(dateTimeOf(nothing as unknown as string)).toBe('');
    }
    // the save line says its time so too (it had said a locale's 12-hour clock, "at 10:53:00 PM", beside the strip's 22:52:47)
    expect(saveState({ revision: 4, savedRevision: 4, savedAt: local.toISOString(), saving: false, conflict: null, stale: null, refused: null, failed: null }).words).toBe('Saved: revision 4, at 09:05:07.');
  });

  it('puts the one primary first in reading order, keeping the number the frame gave it; a second primary is an ordinary action', () => {
    const v = frameView(frame())!;
    expect(v.actions.map((a) => [a.n, a.label, a.primary])).toEqual([[2, 'Ask Timmy to draw', true], [1, 'Open Studio', false], [3, 'Show the board', false]]);
    const two = frameView(frame({ actions: { studio: [{ n: 1, label: 'A', command: '/a', primary: true }, { n: 2, label: 'B', command: '/b', primary: true }] } }))!;
    expect(two.actions.filter((a) => a.primary).map((a) => a.n)).toEqual([1]);
  });
});

/**
 * R7 (H151): the frame's own words, from its producer (src/ops/workspace-frame.ts actionsOf, the lead's 2ee969f) and its tabs
 * (src/contracts/workspace.ts TABS), so the strip's reading of them is checked against what the frame really sends.
 */
describe("the Studio strip's view of a frame (R7 H151): the draft's step, the page's own decision, the unfinished tabs, the cadence", () => {
  const wb = (waiting: number, running = 0) => ({
    route: { ready: true }, activity: { waiting_on_you: waiting, running, stop_current: { job: null, words: 'Stop current: idle' } }, workflows: { docs: [] }, jobs: [],
  }) as unknown as Parameters<typeof actionsOf>[0];
  /** a FAKE frame whose Studio actions and tabs are the producer's, with `drafts` waiting on the board (the frame counts them once) */
  const drafted = (drafts: number, o: { running?: number; studioRunning?: boolean } = {}) => {
    const waiting = drafts > 0 ? 1 : 0;
    return frame({
      tabs: TABS.map((t) => ({ id: t.id, key: t.key, label: t.label, waiting: t.id === 'home' || t.id === 'control' ? waiting : 0, ...(t.unfinished ? { unfinished: t.unfinished } : {}) })),
      actions: { studio: actionsOf(wb(waiting, o.running ?? 0), [], { studioRunning: o.studioRunning ?? true, drafts }).studio },
      activity: { running: o.running ?? 0, waitingOnYou: waiting, stopCurrent: { job: null, words: 'Stop current: idle' } },
    });
  };

  it('knows the frame\'s draft step by its command (opened or not): it is the one primary, done on this page', () => {
    for (const studioRunning of [true, false]) {
      const v = frameView(drafted(1, { studioRunning }))!;
      const primary = v.actions.filter((a) => a.primary);
      expect(primary).toHaveLength(1);
      expect(primary[0]).toMatchObject({ n: 1, label: 'Accept or discard the draft Timmy proposed', draft: true, decided: false });
      expect(v.actions.filter((a) => a.draft)).toHaveLength(1);
      expect(isDraftStep(primary[0])).toBe(true);
    }
    expect(frameView(drafted(2))!.actions[0]).toMatchObject({ label: 'Accept or discard the 2 drafts Timmy proposed', draft: true, primary: true });
    // no draft: Studio's step is the canvas's, and no action is the draft's
    const none = frameView(drafted(0))!;
    expect(none.actions.find((a) => a.primary)).toMatchObject({ command: '/canvas open', draft: false });
    expect(none.actions.some((a) => a.draft)).toBe(false);
    expect(DRAFT_STEP.test('/canvas open')).toBe(false);
  });

  it('the page\'s own decision shows at once: with no draft left on its board, the frame\'s draft step is drawn as decided (no primary), and its waiting counts one less until the frame is read again', () => {
    const f = drafted(1);
    const before = frameView(f, { drafts: 1 })!;
    expect(before.activity.waiting).toBe(1);
    expect(before.tabs.filter((t) => t.waiting).map((t) => [t.id, t.waiting])).toEqual([['home', 1], ['control', 1]]);
    expect(before.actions.filter((a) => a.primary).map((a) => a.draft)).toEqual([true]);
    const after = frameView(f, { drafts: 0 })!;
    expect(after.actions.filter((a) => a.primary)).toEqual([]);
    expect(after.actions.find((a) => a.draft)).toMatchObject({ decided: true, primary: false, label: 'Accept or discard the draft Timmy proposed' });
    expect(after.activity.waiting).toBe(0);
    expect(after.tabs.filter((t) => t.waiting)).toEqual([]);
    expect(after.decided).toBe(true);
    // a frame that names no draft step is never changed by the page's count (the frame is read again for what came since)
    const plain = frameView(drafted(0), { drafts: 1 })!;
    expect(plain.decided).toBe(false);
    expect(plain.actions.find((a) => a.primary)).toMatchObject({ command: '/canvas open' });
    // nothing known of the page's board (switching, or nothing loaded): the frame as it is
    expect(frameView(f, null)!.actions.filter((a) => a.primary).map((a) => a.draft)).toEqual([true]);
    // and never below none waiting
    const other = { ...drafted(1), activity: { running: 0, waitingOnYou: 0, stopCurrent: { job: null, words: '' } } };
    expect(frameView(other, { drafts: 0 })!.activity.waiting).toBe(0);
  });

  it('carries each unfinished tab\'s words as the frame gives them (works now, not yet), and none for a tab whose interactions work', () => {
    const v = frameView(drafted(0))!;
    const unfinished = TABS.filter((t) => t.unfinished);
    expect(unfinished.map((t) => t.key)).toEqual(['6', '7', '8', '0']);
    expect(v.tabs.filter((t) => t.unfinished).map((t) => [t.key, t.unfinished])).toEqual(unfinished.map((t) => [t.key, t.unfinished]));
    expect(v.tabs.filter((t) => !t.unfinished).map((t) => t.key)).toEqual(['1', '2', '3', '4', '5', '9']);
    // its title names it unfinished too (the strip's own description says it in full, where it can be read)
    for (const t of v.tabs.filter((x) => x.unfinished)) expect(t.title).toContain(`unfinished. Works now: ${t.unfinished!.works}. Not yet: ${t.unfinished!.missing}.`);
    // a malformed entry is none, never made up
    const odd = frameView(frame({ tabs: [{ id: 'create', key: '6', label: '3D & Motion', waiting: 0, unfinished: { works: 7 } }] }))!;
    expect(odd.tabs[0].unfinished).toBeNull();
  });

  it(`reads the frame every ${FRAME_FAST_MS} ms while something runs or a chat turn is being answered (a stop elsewhere shows at once), else every ${FRAME_EVERY_MS} ms`, () => {
    expect(FRAME_FAST_MS).toBeLessThanOrEqual(250);
    expect(nextReadMs(frameView(drafted(0))!)).toBe(FRAME_EVERY_MS);
    expect(nextReadMs(frameView(drafted(0, { running: 1 }))!)).toBe(FRAME_FAST_MS);
    const turning = frameView(frame({ activity: { running: 0, waitingOnYou: 0, stopCurrent: { job: null, words: '' }, chatTurn: { surface: 'repl', since: at(1), words: 'a chat turn is being answered in the REPL' } } }))!;
    expect(nextReadMs(turning)).toBe(FRAME_FAST_MS);
    expect(nextReadMs(null)).toBe(FRAME_EVERY_MS);
  });
});
