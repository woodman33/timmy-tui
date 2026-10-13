/**
 * Round R4 (H75): the drawn cards' own rules (companion/studio-canvas/src/cards.js), run here in Node: when a card is
 * executable and when a diagram (and the words for each), the exact actions its buttons send (the live board's own shapes),
 * and what a card keeps of a reading. The cards themselves run in a real Chromium in tests/studio-cards-browser.test.ts.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the page's module is plain JavaScript, bundled for the browser
import { cardMode, CARD_SHAPES, drawnType, keptDetail, offeredNow, rebuildAct, runAct, saveAct, shapeTypeFor, shownValue, stillRunning, withheldData } from '../companion/studio-canvas/src/cards.js';
import { workflowForBoard } from '../src/repl/board-nodes.js';
import { connectWorkflow } from '../src/repl/board-workflows.js';
import { workflowDetail } from '../src/studio/card-detail.js';

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

  it('R4 (H88; r23): a workflow that names two blocks alike: its card detail runs none of them and says why; no Run action is made for any block', () => {
    const F = '```';
    const text = ['# Twice', '', `${F}bash [name:build]`, 'echo one', F, '', `${F}bash [name:build]`, 'echo two', F, ''].join('\n');
    const d = workflowDetail(connectWorkflow(workflowForBoard('DUP.md', { text, sha256: 'b'.repeat(64) }), { root: '', jobs: [], chain: [], files: [] }), (v: unknown) => String(v));
    expect(d).toMatchObject({ runnable: false, notRunnable: '/run runs none of the blocks of DUP.md until each block has a name of its own: it names two blocks build (blocks 1 and 2), and Timmy cannot tell which of them upmd would run.' });
    expect(d.blocks.map((b) => b.runnable)).toEqual([false, false]);
    expect(runAct(d, 'build')).toBeNull();
    // a document whose names are its own still runs, and says nothing of it
    const one = workflowDetail(connectWorkflow(workflowForBoard('ONE.md', { text: text.replace('[name:build]\necho two', '[name:test]\necho two'), sha256: 'c'.repeat(64) }), { root: '', jobs: [], chain: [], files: [] }), (v: unknown) => String(v));
    expect(one).toMatchObject({ runnable: true, notRunnable: null });
    expect(runAct(one, 'test')).toEqual({ action: 'run', doc: 'ONE.md', block: 'test' });
  });

  it('R4 (H83): a card whose kept detail the server withheld says so (whatever the reading), and a reading refused to the page says why', () => {
    const withheld = { type: 'withheld', project: 'beta', words: 'Withheld: this card\'s kept detail (its commands and values) belongs to beta, and this page\'s session is for another project. To read it, in Timmy, in beta (/project beta switches to it): /canvas open.', commands: ['/project beta', '/canvas open'] };
    expect(withheldData(withheld)).toBe(withheld);
    expect(withheldData({ type: 'workflow' })).toBeNull();
    expect(withheldData(null)).toBeNull();
    for (const reading of [answer(), null, answer({ project: null })]) {
      expect(cardMode('params', { ...props, data: withheld }, reading, true)).toEqual({ executable: false, badge: 'diagram', words: withheld.words, follows: false, withheld: true });
    }
    const refused = 'Refused: this canvas page\'s session was given for another project than the one the canvas shows now. In Timmy: /canvas open, from the REPL that holds this project.';
    expect(cardMode('workflow', props, answer({ project: null, refused }), true)).toEqual({ executable: false, badge: 'diagram', follows: false, words: `Not followed now: ${refused} Shown as last read.` });
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

  it('R4 (H81): a reading without the detail (no session that reads it) makes every card a diagram shown as last read, saying why', () => {
    const why = 'This page reads only the project\'s card list: it has no session from Timmy.';
    const plain = answer({ detail: false, detailWhy: why, cards: [{ id: 'workflow:RUN.md', kind: 'workflow' }] });
    expect(cardMode('workflow', props, plain, true)).toEqual({ executable: false, badge: 'diagram', follows: false, words: `${why} Shown as last read.` });
    expect(cardMode('result', props, plain, true)).toMatchObject({ executable: false, follows: false });
    // the other checks come first: another project is said as such
    expect(cardMode('workflow', props, { ...plain, project: { name: 'other', id: 'f'.repeat(16) } }, true)).toMatchObject({ words: 'Not followed now: the canvas shows other, not demo. Shown as last read.' });
    // a reading with the detail is as before
    expect(cardMode('workflow', props, answer({ detail: true }), true)).toMatchObject({ executable: true });
  });

  it('R4 (H81): a recorded action is sent only while the card\'s reading still offers it: the same block of the same document, the same recipe, a save of the same file', () => {
    expect(offeredNow({ action: 'run', doc: 'RUN.md', block: 'setup' }, workflow)).toBe(true);
    expect(offeredNow({ action: 'run', doc: 'RUN.md', block: 'gone' }, workflow)).toBe(false);
    expect(offeredNow({ action: 'run', doc: 'OTHER.md', block: 'setup' }, workflow)).toBe(false);
    expect(offeredNow({ action: 'run', doc: 'RUN.md', block: 'setup' }, { ...workflow, runnable: false })).toBe(false);
    expect(offeredNow({ action: 'run', doc: 'RUN.md', block: 'setup' }, undefined)).toBe(false);
    const tray = { type: 'params', engine: 'tray', recipe: 'tray', model: null, base: 'b'.repeat(64), rebuild: true, save: { offered: true, why: null }, values: [{ name: 'width', value: 145, kind: 'number' }] };
    expect(offeredNow({ action: 'rebuild', recipe: 'tray' }, tray)).toBe(true);
    expect(offeredNow({ action: 'rebuild', recipe: 'tray' }, { ...tray, rebuild: false })).toBe(false);
    expect(offeredNow({ action: 'set-params', recipe: 'tray', base: 'x', parameters: { width: 160 } }, tray)).toBe(true);
    expect(offeredNow({ action: 'set-params', recipe: 'tray', base: 'x', parameters: { width: 160 } }, { ...tray, save: { offered: false, why: 'a flow runs' } })).toBe(false);
    expect(offeredNow({ action: 'set-scad-params', model: 'box.scad', base: '', parameters: {} }, tray)).toBe(false);
    expect(offeredNow({ action: 'stop', job: 'j000001' }, tray)).toBe(false);
  });
});
