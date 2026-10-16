/**
 * R4 (H109): the Project panel's rules for following the active project and pinning a board (companion/studio-canvas/src/
 * project.js readPin, pinFor, followWords, changeWords), run here in Node; the page itself runs in a real Chromium in
 * tests/studio-follow-browser.test.ts. The readings below are FIXTURES in the shape GET /api/project answers.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the page's module is plain JavaScript, bundled for the browser
import { changeWords, followWords, PIN, pinFor, readPin } from '../companion/studio-canvas/src/project.js';

const A = { id: 'a'.repeat(16), name: 'alpha' };
const B = { id: 'b'.repeat(16), name: 'beta' };

describe('following the active project, and boards pinned to one', () => {
  it("reads a board's pin from its meta field by field, and makes one from the project a reading shows", () => {
    expect(PIN).toBe('timmyPin');
    expect(readPin({ [PIN]: { projectId: A.id, project: ' alpha\n', at: 'x' } })).toEqual({ projectId: A.id, project: 'alpha', at: 'x' });
    expect(readPin({ [PIN]: { projectId: 'nope', project: 'alpha' } })).toBeNull();
    expect(readPin({ [PIN]: { projectId: A.id } })).toEqual({ projectId: A.id, project: A.id, at: null });
    expect(readPin({})).toBeNull();
    expect(readPin(null)).toBeNull();
    expect(pinFor(A, new Date('2026-10-12T00:00:00.000Z'))).toEqual({ projectId: A.id, project: 'alpha', at: '2026-10-12T00:00:00.000Z' });
  });

  it('says whether a board follows or is pinned, and what the canvas and the active project are when they differ', () => {
    // R6 (H139): each project has its own board, so a board is its project's own, and the whole board changes with the project
    const own = "This is alpha's own board: Studio shows the board of the project the canvas shows, and switches to another project's own board when the active project changes.";
    expect(followWords({ project: A }, null)).toBe(own);
    expect(followWords({ project: A, active: A }, null)).toBe(own);
    expect(followWords({ project: A, active: B }, null)).toBe(`${own} The active project of this Timmy home is beta; the canvas shows alpha, as Timmy's REPL named it.`);
    expect(followWords({ project: null }, null)).toBe('This board follows the project the canvas shows (the active project).');
    // a pin kept from the canvas a Timmy home had before (every project's boards in one): the board reads its pinned project's cards
    const pin = { projectId: A.id, project: 'alpha', at: null };
    expect(followWords({ project: A, pinned: true, shown: B }, pin)).toBe("Pinned to alpha: this board reads alpha's cards, whichever project's board holds it. The canvas shows beta now.");
    expect(followWords({ project: A, pinned: true, shown: A }, pin)).toBe("Pinned to alpha: this board reads alpha's cards, whichever project's board holds it.");
    // the canvas's project not told (another REPL's): not named
    expect(followWords({ project: A, pinned: true, shown: null }, pin)).toBe("Pinned to alpha: this board reads alpha's cards, whichever project's board holds it.");
  });

  it("says when a following board's project changed (and only then), and that its cards stay as they were", () => {
    expect(changeWords({ id: A.id, name: 'alpha' }, { project: B, via: 'active' })).toBe('The canvas now shows beta, the active project of this Timmy home (it showed alpha). Cards of alpha on this board stay, shown as last read; nothing on the board was changed.');
    expect(changeWords({ id: A.id, name: 'alpha' }, { project: B, via: 'repl' })).toBe('The canvas now shows beta (it showed alpha). Cards of alpha on this board stay, shown as last read; nothing on the board was changed.');
    expect(changeWords({ id: A.id, name: 'alpha' }, { project: A })).toBeNull();
    expect(changeWords(null, { project: B })).toBeNull();
    expect(changeWords({ id: A.id, name: 'alpha' }, { project: B, pinned: true })).toBeNull();
    expect(changeWords({ id: A.id, name: 'alpha' }, { project: null })).toBeNull();
  });
});
