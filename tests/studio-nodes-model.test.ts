/**
 * R6 (H145, step 4a): the node palette's rules (companion/studio-canvas/src/nodes.js), in Node, on a FIXTURE project reading
 * shaped as GET /api/project answers: the project's cards that draw, grouped by the node each makes (./cards.js drawnType: a
 * parameter, workflow or result node), its operations with at least one card that draws (an operation node), and the words an
 * add refused while Studio switches, is paused or shows no board says. The real browser runs them in
 * tests/studio-nodes-browser.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { drawnType } from '../companion/studio-canvas/src/cards.js';
import { countWords, NODE_KINDS, notNowWords, paletteOf } from '../companion/studio-canvas/src/nodes.js';

/** FIXTURE: a reading of tray (its words FIXTURE where a record would say them). */
const READING = {
  project: { id: 'a'.repeat(16), name: 'tray' },
  cards: [
    { id: 'workflow:BUILD.md', kind: 'workflow', title: 'FIXTURE build', state: '2 blocks' },
    { id: 'params:box.params.json', kind: 'params', title: 'OpenSCAD parameters of box.scad (box.params.json)', state: 'width 90' },
    { id: 'params:recipes/tray.params.json', kind: 'params', title: 'Tray recipe parameters (recipes/tray.params.json)', state: 'width 145' },
    { id: 'flow:f1a2b3c4d', kind: 'flow', title: 'FIXTURE flow', state: 'succeeded' },
    { id: 'vox:v1a2b3c4d', kind: 'vox', title: 'measure part.stl', state: 'ok' },
    { id: 'run:task:j1', kind: 'run', title: 'repl · j1', state: 'done' },
    { id: 'unreadable:results/flows/f0badbad0.json', kind: 'unreadable', title: 'Unreadable record', state: 'unreadable: not JSON' },
  ],
  operations: [
    { id: 'oa1b2c3d4', request: '/run RUN.md build', state: 'succeeded', cards: ['workflow:BUILD.md', 'flow:f1a2b3c4d', 'flow:f1a2b3c4d', 'unreadable:results/flows/f0badbad0.json'] },
    { id: 'ob1b2c3d4', request: 'only an unreadable record', state: 'failed', cards: ['unreadable:results/flows/f0badbad0.json'] },
    { id: 'not-an-operation', request: 'x', state: 'x', cards: ['workflow:BUILD.md'] },
  ],
};

describe('the node palette\'s rules (R6 H145, step 4a)', () => {
  it('groups the project\'s cards that draw by the node each makes, and offers each operation with a card that draws', () => {
    const p = paletteOf(READING, drawnType);
    expect(p.project).toEqual({ id: 'a'.repeat(16), name: 'tray' });
    expect(p.groups.map((g) => [g.kind, g.title, g.items.map((i) => i.id)])).toEqual([
      ['params', 'Parameter nodes', ['params:box.params.json', 'params:recipes/tray.params.json']],
      ['workflow', 'Workflow nodes', ['workflow:BUILD.md']],
      ['result', 'Result nodes', ['flow:f1a2b3c4d', 'vox:v1a2b3c4d', 'run:task:j1']],
      ['operation', 'Operation nodes', ['oa1b2c3d4']],
    ]);
    // a result node keeps the kind of its card (flow, vox, run); an operation says its state and how many of its cards draw
    expect(p.groups[2].items.map((i) => i.kind)).toEqual(['flow', 'vox', 'run']);
    expect(p.groups[3].items[0]).toEqual({ id: 'oa1b2c3d4', kind: 'operation', title: '/run RUN.md build', state: 'succeeded · 2 cards that draw' });
    // an unreadable record makes no node; nor does an operation whose cards none draw, or an id that is not an operation's
    expect(JSON.stringify(p)).not.toMatch(/unreadable:|ob1b2c3d4|not-an-operation/);
    expect(countWords(p)).toBe('2 parameter · 1 workflow · 3 result · 1 operation');
    expect(NODE_KINDS.map((k) => k.kind)).toEqual(['params', 'workflow', 'result', 'operation']);
  });

  it('a reading with nothing (a refusal, no project) offers nothing, and says so per kind', () => {
    const p = paletteOf({ project: null, message: 'No project is named to this canvas.' }, drawnType);
    expect(p.project).toBeNull();
    expect(p.groups.every((g) => g.items.length === 0)).toBe(true);
    expect(countWords(p)).toBe('0 parameter · 0 workflow · 0 result · 0 operation');
  });

  it('an add refused while Studio switches, is paused or shows no board says so', () => {
    expect(notNowWords({ state: 'switching', switching: { id: 'b'.repeat(16), name: 'blank' } })).toBe('Not added: Studio is switching to blank, so no node is added to either board until its board is loaded.');
    expect(notNowWords({ state: 'paused', paused: 'Another REPL holds the canvas.' })).toBe('Not added: Another REPL holds the canvas.');
    expect(notNowWords({ state: 'none' })).toBe('Not added: no board is on screen yet.');
  });
});
