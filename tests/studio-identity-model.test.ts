/**
 * R6 (H139): the page's one record of whose board is on screen (companion/studio-canvas/src/identity.js), run here in Node: its
 * states, the generations that tell a reading made before a switch from one made after, and its words. The page itself runs in a
 * real Chromium in tests/studio-isolation-browser.test.ts. The projects below are FIXTURES in the shape the canvas server names them.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the page's module is plain JavaScript, bundled for the browser
import { blockedWords, coverWords, createIdentity, KEPT_MAX, keptWords, projectOf, sameProject, switchedWords, switchingTo } from '../companion/studio-canvas/src/identity.js';

const TRAY = { id: 'a'.repeat(16), name: 'tray' };
const BLANK = { id: 'b'.repeat(16), name: 'blank' };

describe("the page's identity: whose board is on screen", () => {
  it('reads a project field by field, and tells two apart by id', () => {
    expect(projectOf({ id: TRAY.id, name: ' tray\n' })).toEqual(TRAY);
    expect(projectOf({ id: TRAY.id })).toEqual({ id: TRAY.id, name: TRAY.id });
    for (const bad of [null, {}, { id: 'nope', name: 'x' }, { id: 7 }, 'tray']) expect(projectOf(bad)).toBeNull();
    expect(sameProject(TRAY, { id: TRAY.id, name: 'renamed' })).toBe(true);
    expect(sameProject(TRAY, BLANK)).toBe(false);
    expect(sameProject(null, TRAY)).toBe(false);
  });

  it('none → shown → switching → shown: blocked while switching; a ticket from before the switch is never current again', () => {
    const lines: string[] = [];
    const id = createIdentity({ now: () => Date.parse('2026-10-16T17:00:00.000Z'), log: (w: string) => lines.push(w) });
    expect(id.state).toBe('none');
    expect(id.blocked()).toBe(true);
    id.show(TRAY);
    expect(id.state).toBe('shown');
    expect(id.blocked()).toBe(false);
    const before = id.ticket();
    expect(before).toEqual({ gen: id.gen, project: TRAY.id });
    expect(id.current(before)).toBe(true);
    expect(id.belongs(TRAY.id)).toBe(true);
    expect(id.belongs(BLANK.id)).toBe(false);
    const g = id.begin(BLANK);
    expect(id.state).toBe('switching');
    expect(id.switching).toEqual(BLANK);
    expect(id.project).toEqual(TRAY);
    expect(id.blocked()).toBe(true);
    // while switching nothing is current, not even the board still on screen's
    expect(id.current(before)).toBe(false);
    expect(id.current(id.ticket())).toBe(false);
    expect(id.belongs(TRAY.id)).toBe(false);
    expect(id.finish(g, BLANK)).toBe(true);
    expect(id.state).toBe('shown');
    expect(id.project).toEqual(BLANK);
    expect(id.current(before)).toBe(false);
    expect(id.current(id.ticket())).toBe(true);
    expect(lines).toEqual([]);
  });

  it('a switch another one overtakes does not finish; the newest does', () => {
    const id = createIdentity();
    id.show(TRAY);
    const toBlank = id.begin(BLANK);
    const backToTray = id.begin(TRAY);
    expect(id.finish(toBlank, BLANK)).toBe(false);
    expect(id.state).toBe('switching');
    expect(id.switching).toEqual(TRAY);
    expect(id.finish(backToTray, TRAY)).toBe(true);
    expect(id.project).toEqual(TRAY);
  });

  it('paused: no board shown, nothing current, blocked, in its own words; a project it can show takes it out of the pause', () => {
    const id = createIdentity();
    id.show(TRAY);
    const t = id.ticket();
    id.pause('The canvas shows a project of another Timmy REPL now.');
    expect(id.state).toBe('paused');
    expect(id.blocked()).toBe(true);
    expect(id.current(t)).toBe(false);
    expect(blockedWords(id)).toBe('The canvas shows a project of another Timmy REPL now. Nothing on this page edits, accepts or discards until the canvas shows a project it can show.');
    const g = id.begin(TRAY);
    expect(id.state).toBe('switching');
    expect(id.finish(g, TRAY)).toBe(true);
    expect(id.state).toBe('shown');
  });

  it("keeps the newest lines of its Kept apart log first, at most KEPT_MAX, each told to its log as it comes", () => {
    const told: string[] = [];
    let n = 0;
    const id = createIdentity({ now: () => Date.parse('2026-10-16T17:00:00.000Z') + (n++) * 1000, log: (w: string) => told.push(w) });
    for (let i = 0; i < KEPT_MAX + 3; i++) id.note(`line ${i}`);
    expect(id.kept).toHaveLength(KEPT_MAX);
    expect(id.kept[0]).toEqual({ at: expect.stringMatching(/^2026-10-16T17:00:14/), words: `line ${KEPT_MAX + 2}` });
    expect(told).toHaveLength(KEPT_MAX + 3);
    // a copy: changing what was handed out changes nothing kept
    id.kept[0].words = 'changed';
    expect(id.kept[0].words).toBe(`line ${KEPT_MAX + 2}`);
  });

  it('says what it does, in the words the page shows', () => {
    const id = createIdentity();
    id.show(TRAY);
    expect(blockedWords(id)).toBeNull();
    id.begin(BLANK);
    expect(switchingTo(BLANK)).toBe('switching to blank…');
    expect(blockedWords(id)).toBe("Studio is switching to blank: editing, Accept and Discard wait until blank's board is loaded.");
    expect(coverWords(TRAY, BLANK)).toBe("Switching to blank… tray's board, drafts and canvas jobs are saved and put away, as they are. Nothing of tray is shown here under blank's name.");
    expect(switchedWords(TRAY, BLANK)).toBe("Studio shows blank now: its own board, drafts and canvas jobs. tray's board, drafts and canvas jobs are kept as they were, in tray.");
    expect(switchedWords(null, BLANK, 'active')).toBe('Studio shows blank, the active project of this Timmy home now: its own board, drafts and canvas jobs.');
    expect(keptWords('call', TRAY, BLANK, 'job turn-1')).toBe("A canvas call for tray (job turn-1) reached this page after Studio left tray's board for blank's: it did not run here, and nothing was drawn on either board.");
    expect(keptWords('save', TRAY, BLANK, 'revision 7')).toBe("tray's save (revision 7) landed after Studio switched to blank: it is kept on tray's own board, and nothing of it is shown here.");
    expect(keptWords('decision', TRAY, BLANK, 'accepted')).toBe("The record of a decision on tray's draft (accepted) was written to tray's own drafts record, after Studio switched to blank.");
    expect(keptWords('reading', TRAY, BLANK, 'its canvas jobs')).toBe('A reading of tray (its canvas jobs) came back after Studio switched to blank: it was dropped, and nothing of it is shown here.');
    expect(keptWords('early', BLANK, BLANK, 'job turn-2')).toBe("A canvas call for blank (job turn-2) reached this page while Studio was still loading blank's board: it did not run, and nothing was drawn on either board. Asked again, it runs on blank's board.");
  });
});
