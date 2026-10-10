/**
 * Round R4 (H75): the drawn cards' own rules (companion/studio-canvas/src/cards.js), run here in Node: when a card is
 * executable and when a diagram (and the words for each), the exact actions its buttons send (the live board's own shapes),
 * and what a card keeps of a reading. The cards themselves run in a real Chromium in tests/studio-cards-browser.test.ts.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the page's module is plain JavaScript, bundled for the browser
import { cardMode, CARD_SHAPES, drawnType, keptDetail, rebuildAct, runAct, saveAct, shapeTypeFor, shownValue, stillRunning } from '../companion/studio-canvas/src/cards.js';

const project = { name: 'demo', id: 'abcdef0123456789' };
const props = { card: 'workflow:RUN.md', projectId: project.id, project: 'demo' };
const workflow = {
  type: 'workflow', doc: 'RUN.md', sha256: 'a'.repeat(64), runnable: true, running: false, last: null,
  blocks: [{ name: 'setup', key: '1', word: 'not run yet', glyph: '·', detail: '', needs: [], runnable: true, command: [] }, { name: 'two words', key: '2', word: 'not run yet', glyph: '·', detail: '', needs: [], runnable: false, command: [] }],
};
const answer = (o: Record<string, unknown> = {}) => ({ project, madeAt: '2026-10-10T12:00:00.000Z', cards: [{ id: 'workflow:RUN.md', kind: 'workflow', detail: workflow }], actions: { holder: true, words: 'The Timmy REPL that named demo takes its cards\' actions from this canvas.' }, ...o });

describe("Timmy Canvas's drawn cards", () => {
  it('each kind of project card has its drawn card; an unreadable record has none', () => {
    expect(['workflow', 'params', 'flow', 'vox', 'run', 'unreadable'].map(drawnType)).toEqual(['workflow', 'params', 'result', 'result', 'result', null]);
    expect(shapeTypeFor('vox')).toBe(CARD_SHAPES.result);
    expect(Object.values(CARD_SHAPES)).toEqual(['timmy-workflow', 'timmy-params', 'timmy-result']);
  });

  it('is executable only when the canvas follows its project, a REPL takes the actions and this page has a session; else a diagram saying which is missing', () => {
    expect(cardMode('workflow', props, answer(), true)).toMatchObject({ executable: true, badge: 'executable', follows: true });
    expect(cardMode('workflow', props, answer(), false)).toMatchObject({ executable: false, badge: 'diagram', follows: true, words: expect.stringMatching(/^Read from Timmy now, but this page cannot act/) });
    expect(cardMode('workflow', props, answer({ actions: { holder: false, words: 'No Timmy REPL takes demo\'s card actions now.' } }), true)).toMatchObject({ executable: false, words: 'No Timmy REPL takes demo\'s card actions now.' });
    expect(cardMode('workflow', props, answer({ project: { name: 'other', id: 'f'.repeat(16) } }), true)).toMatchObject({ executable: false, follows: false, words: 'Not followed now: the canvas shows other, not demo. Shown as last read.' });
    expect(cardMode('workflow', props, answer({ project: null }), true)).toMatchObject({ executable: false, follows: false, words: expect.stringMatching(/^Not followed now: no project is named to this canvas/) });
    expect(cardMode('workflow', props, answer({ cards: [] }), true)).toMatchObject({ executable: false, words: 'Its record is not in demo now: shown as last read.' });
    expect(cardMode('workflow', props, null, true)).toMatchObject({ executable: false, words: 'Not read from Timmy yet.' });
    // A result card is a diagram of its record, always.
    expect(cardMode('result', { ...props, card: 'workflow:RUN.md' }, answer(), true)).toMatchObject({ executable: false, badge: 'diagram', follows: true });
  });

  it("sends exactly the live board's actions: run (only a block /run can name), rebuild, and the saves with the base the card was drawn from", () => {
    expect(runAct(workflow, 'setup')).toEqual({ action: 'run', doc: 'RUN.md', block: 'setup' });
    expect(runAct(workflow, 'two words')).toBeNull();
    expect(runAct(workflow, 'nope')).toBeNull();
    expect(runAct({ ...workflow, runnable: false }, 'setup')).toBeNull();
    const tray = { type: 'params', engine: 'tray', recipe: 'tray', model: null, base: 'b'.repeat(64), rebuild: true, save: { offered: true, why: null }, values: [{ name: 'width', value: 145, kind: 'number' }, { name: 'bore', value: 3, kind: 'number' }] };
    expect(rebuildAct(tray)).toEqual({ action: 'rebuild', recipe: 'tray' });
    expect(saveAct(tray, { width: ' 160 ', bore: 'abc' }, tray.base)).toEqual({ action: 'set-params', recipe: 'tray', base: tray.base, parameters: { width: 160, bore: 'abc' } });
    // No file yet: the base is null, as the board sends it.
    expect(saveAct(tray, {}, null)).toEqual({ action: 'set-params', recipe: 'tray', base: null, parameters: { width: 145, bore: 3 } });
    const scad = { type: 'params', engine: 'scad', recipe: null, model: 'box.scad', base: 'c'.repeat(64), rebuild: false, save: { offered: true, why: null }, values: [{ name: 'width', value: 90, kind: 'number' }, { name: 'hollow', value: true, kind: 'boolean' }, { name: 'label', value: 'A', kind: 'text' }] };
    expect(rebuildAct(scad)).toBeNull();
    expect(saveAct(scad, { width: '1e2', hollow: 'false', label: ' B ' }, scad.base)).toEqual({ action: 'set-scad-params', model: 'box.scad', base: scad.base, parameters: { width: 100, hollow: false, label: ' B ' } });
    // A value of the wrong kind goes as typed, so Timmy refuses it in words.
    expect(saveAct(scad, { width: 'wide' }, scad.base).parameters.width).toBe('wide');
    expect(saveAct({ ...scad, save: { offered: false, why: 'no workflow block names box.params.json' } }, {}, scad.base)).toBeNull();
  });

  it("keeps a reading without a running run's time so far, and knows when a card's job still runs", () => {
    const result = { type: 'result', verdict: { word: 'running', tone: 'running', words: 'running' }, facts: [{ label: 'time', value: '3 s', how: 'so far' }, { label: 'owner', value: 'x', how: 'y' }] };
    expect(keptDetail(result).facts).toEqual([{ label: 'owner', value: 'x', how: 'y' }]);
    expect(keptDetail(workflow)).toBe(workflow);
    expect(keptDetail(undefined)).toBeNull();
    expect([stillRunning(result), stillRunning({ ...workflow, running: true }), stillRunning(workflow), stillRunning({ type: 'params', build: { tone: 'running' } }), stillRunning(null)]).toEqual([true, true, false, true, false]);
    expect([shownValue(155.0000001), shownValue(true), shownValue('A')]).toEqual(['155', 'true', 'A']);
  });
});
