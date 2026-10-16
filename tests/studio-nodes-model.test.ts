/**
 * R6 (H145, step 4a): the node palette's rules (companion/studio-canvas/src/nodes.js), in Node, on a FIXTURE project reading
 * shaped as GET /api/project answers: the project's cards that draw, grouped by the node each makes (./cards.js drawnType: a
 * parameter, workflow or result node), its operations with at least one card that draws (an operation node), and the words an
 * add refused while Studio switches, is paused or shows no board says. The real browser runs them in
 * tests/studio-nodes-browser.test.ts.
 *
 * R6 (H145, step 4c): and the connections' rules: each operation's cards in the order an operation node links them
 * (./operations.js placementPlan), what an arrow between two nodes means (data along an operation's own link, else a link
 * without data, with why), when Studio labels an arrow, who drew one, and the words a refused connection says.
 */
import { describe, expect, it } from 'vitest';
import { drawnType } from '../companion/studio-canvas/src/cards.js';
import { placementPlan } from '../companion/studio-canvas/src/operations.js';
import { arrowBy, CALLING_WORDS, connectionOf, countWords, labelsNow, laneOf, LINK_LABEL, LINK_META, linkMeta, NODE_KINDS, nodeOf, notNowConnectWords, notNowWords, ordersOf, paletteOf, recordsOf, richWords } from '../companion/studio-canvas/src/nodes.js';

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

/** FIXTURE: a reading of tray with an operation whose records hold one unreadable record between two cards that draw. */
const OP = 'oc0ffee00';
const READING_4C = {
  project: { id: 'a'.repeat(16), name: 'tray' },
  cards: [
    { id: 'workflow:BUILD.md', kind: 'workflow', title: 'FIXTURE build', operation: OP },
    { id: 'params:box.params.json', kind: 'params', title: 'box.params.json' },
    { id: 'flow:f1a2b3c4d', kind: 'flow', title: 'FIXTURE flow', operation: OP },
    { id: 'vox:v1a2b3c4d', kind: 'vox', title: 'FIXTURE vox', operation: OP },
    { id: 'run:task:j1', kind: 'run', title: 'repl · j1', operation: 'od0ffee00' },
    { id: 'unreadable:results/flows/f0badbad0.json', kind: 'unreadable', title: 'Unreadable record', operation: OP },
  ],
  operations: [
    { id: OP, request: 'FIXTURE /run', state: 'succeeded', cards: ['workflow:BUILD.md', 'unreadable:results/flows/f0badbad0.json', 'flow:f1a2b3c4d', 'flow:f1a2b3c4d', 'vox:v1a2b3c4d', 'gone:card'] },
    { id: 'od0ffee00', request: 'FIXTURE task', state: 'done', cards: ['run:task:j1'] },
    { id: 'not-an-operation', cards: ['workflow:BUILD.md'] },
  ],
};
const PID = 'a'.repeat(16);
/** A drawn card on the board (a tldraw shape record, as the page holds one): its card, and the operation it was placed for. */
const card = (id: string, cardId: string, type: string, op: string | null = null, projectId = PID) => ({
  typeName: 'shape', id: `shape:${id}`, type, props: { card: cardId, projectId, project: 'tray', title: cardId.replace(/^[a-z]+:/, '') }, meta: op ? { timmyOperation: op } : {},
});
const rich = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] });
const arrow = (text: string, meta: Record<string, unknown> = {}) => ({ typeName: 'shape', id: 'shape:arrow1', type: 'arrow', props: { richText: rich(text) }, meta });

describe('the nodes\' connections: data flows only along an operation\'s own links (R6 H145, step 4c)', () => {
  const orders = ordersOf(READING_4C, drawnType);
  const records = recordsOf(READING_4C);
  const wf = nodeOf(card('wf', 'workflow:BUILD.md', 'timmy-workflow', OP))!;
  const fl = nodeOf(card('fl', 'flow:f1a2b3c4d', 'timmy-result', OP))!;
  const vx = nodeOf(card('vx', 'vox:v1a2b3c4d', 'timmy-result', OP))!;

  it("each operation's cards in the order an operation node links them: its cards that draw, each once, as placementPlan orders them", () => {
    expect(orders).toEqual({ [OP]: ['workflow:BUILD.md', 'flow:f1a2b3c4d', 'vox:v1a2b3c4d'], od0ffee00: ['run:task:j1'] });
    const byId = new Map(READING_4C.cards.map((c) => [c.id, c]));
    for (const op of READING_4C.operations.filter((o) => /^o[0-9a-f]{8}$/.test(o.id))) {
      expect(orders[op.id], op.id).toEqual(placementPlan(op, byId, (kind: string) => drawnType(kind) !== null, null, () => false).order);
    }
    expect(records).toEqual({ 'workflow:BUILD.md': OP, 'flow:f1a2b3c4d': OP, 'vox:v1a2b3c4d': OP, 'run:task:j1': 'od0ffee00', 'unreadable:results/flows/f0badbad0.json': OP });
    // a card on the board as the rules read it; anything that is not one of Timmy's cards is not a node
    expect(wf).toEqual({ id: 'shape:wf', type: 'timmy-workflow', card: 'workflow:BUILD.md', projectId: PID, project: 'tray', op: OP, title: 'BUILD.md' });
    expect(nodeOf({ typeName: 'shape', id: 'shape:n', type: 'note', props: {}, meta: {} })).toBeNull();
    expect(nodeOf(card('a1', 'vox:v1a2b3c4d', 'timmy-artifact'))?.op).toBeNull();
  });

  it('data flows from a card its operation node placed to the card that ran next (over a record with no drawn card), and nowhere else', () => {
    expect(connectionOf(wf, fl, orders, records)).toEqual({ data: true, op: OP, words: `Data flows: BUILD.md → f1a2b3c4d, the next step of operation ${OP} in the order its records give.` });
    expect(connectionOf(fl, vx, orders, records).data).toBe(true);
    expect(connectionOf(fl, wf, orders, records)).toEqual({ data: false, words: `Link only, no data flows: BUILD.md ran before f1a2b3c4d in operation ${OP}.` });
    expect(connectionOf(wf, vx, orders, records)).toEqual({ data: false, words: `Link only, no data flows: BUILD.md and v1a2b3c4d are not consecutive steps of operation ${OP}.` });
    // the same cards when the reading does not list the operation's order
    expect(connectionOf(wf, fl, {}, records).words).toBe(`Link only, no data flows: the project's records, as Timmy reads them now, do not list both BUILD.md and f1a2b3c4d among operation ${OP}'s cards.`);
    // cards placed for different operations
    const run = nodeOf(card('run', 'run:task:j1', 'timmy-result', 'od0ffee00'))!;
    expect(connectionOf(vx, run, orders, records).words).toBe(`Link only, no data flows: v1a2b3c4d and task:j1 were placed for different operations (${OP}, od0ffee00).`);
    // the next step of the operation, but a card not placed for it (a node of one card): no data, and why
    const flAlone = nodeOf(card('fl2', 'flow:f1a2b3c4d', 'timmy-result'))!;
    const wfAlone = nodeOf(card('wf2', 'workflow:BUILD.md', 'timmy-workflow'))!;
    expect(connectionOf(wf, flAlone, orders, records).words).toBe(`Link only, no data flows: f1a2b3c4d ran right after BUILD.md in operation ${OP}, but f1a2b3c4d was not placed for it, and data flows only between the cards its operation node places.`);
    expect(connectionOf(wfAlone, flAlone, orders, records).words).toBe(`Link only, no data flows: f1a2b3c4d ran right after BUILD.md in operation ${OP}, but neither card was placed for it, and data flows only between the cards its operation node places.`);
    // no record names a path: a parameter node to a workflow node
    const params = nodeOf(card('p', 'params:box.params.json', 'timmy-params'))!;
    expect(connectionOf(params, wfAlone, orders, records)).toEqual({ data: false, words: "Link only, no data flows: Timmy's records name no data path from box.params.json to BUILD.md; data flows only along an operation's own links." });
    // two drawn cards of one record
    expect(connectionOf(wf, wfAlone, orders, records).words).toBe('Link only, no data flows: both ends are drawn cards of one record (BUILD.md).');
  });

  it('a connection of a node to itself, across projects, or to a shape that is not a card is refused, in words', () => {
    expect(connectionOf(wf, wf, orders, records)).toEqual({ refused: true, words: 'Not connected: BUILD.md is not connected to itself.' });
    const other = nodeOf(card('o', 'workflow:BUILD.md', 'timmy-workflow', null, 'b'.repeat(16)))!;
    expect(connectionOf(wf, other, orders, records)).toEqual({ refused: true, words: "Not connected: BUILD.md and BUILD.md are cards of different projects; a node is connected on its own project's board only." });
    expect(connectionOf(wf, null, orders, records).refused).toBe(true);
    expect(notNowConnectWords({ state: 'switching', switching: { id: 'b'.repeat(16), name: 'blank' } })).toBe('Not connected: Studio is switching to blank, so nothing is connected on either board until its board is loaded.');
    expect(notNowConnectWords({ state: 'paused', paused: 'Another REPL holds the canvas.' })).toBe('Not connected: Another REPL holds the canvas.');
    expect(notNowConnectWords({ state: 'none' })).toBe('Not connected: no board is on screen yet.');
    expect(CALLING_WORDS).toBe("Not connected: a call of Timmy's is drawing on this board now (what it draws is its own until it ends); connect the two nodes once it ends.");
  });

  it('Studio labels an arrow once: no data along it, no words on it, never labelled before, not a draft\'s; and says who drew each', () => {
    const link = { data: false, words: 'Link only, no data flows: x.' };
    expect(richWords(rich(LINK_LABEL))).toBe('link only · no data flows');
    expect(richWords({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'lines' }] }] })).toBe('two lines');
    expect(labelsNow(arrow(''), link)).toBe(true);
    expect(labelsNow(arrow('feeds the tray'), link)).toBe(false);
    expect(labelsNow(arrow('', { [LINK_META]: { v: 1 } }), link)).toBe(false);
    expect(labelsNow(arrow('', { timmyDraft: { id: 'd1' } }), link)).toBe(false);
    expect(labelsNow(arrow(''), { data: true, op: OP, words: '' })).toBe(false);
    expect(labelsNow(arrow(''), { data: null, words: '' })).toBe(false);
    expect(labelsNow(arrow(''), { refused: true, words: '' })).toBe(false);
    const params = nodeOf(card('p', 'params:box.params.json', 'timmy-params'))!;
    expect(linkMeta(params, wf, 'connect', '2026-10-16T00:00:00.000Z')).toEqual({ v: 1, from: 'params:box.params.json', to: 'workflow:BUILD.md', project: PID, data: false, by: 'connect', at: '2026-10-16T00:00:00.000Z' });
    // who drew it, and what became of its words
    expect(arrowBy(arrow('', { timmyOperation: OP }), { data: true })).toBe(`drawn for operation ${OP}`);
    expect(arrowBy(arrow('', { timmyOperation: OP }), link)).toBe(`drawn for operation ${OP}, now between other cards`);
    expect(arrowBy(arrow(LINK_LABEL, { [LINK_META]: { by: 'connect' } }), link)).toBe('drawn by Connect');
    expect(arrowBy(arrow('mine', { [LINK_META]: { by: 'connect' } }), link)).toBe('drawn by Connect; its words changed by hand');
    expect(arrowBy(arrow(LINK_LABEL, { [LINK_META]: { by: 'label' } }), link)).toBe('drawn by hand; labelled by Studio');
    expect(arrowBy(arrow('', { [LINK_META]: { by: 'label' } }), link)).toBe('drawn by hand; its label taken off by hand');
    expect(arrowBy(arrow(''), link)).toBe('drawn by hand');
    expect(arrowBy(arrow('feeds the tray'), link)).toBe('drawn by hand; its own words kept');
    expect(arrowBy(arrow('', { timmyJob: 'j1' }), link)).toBe('drawn by job j1');
    expect(arrowBy(arrow('', { timmyDraft: { id: 'd1' } }), link)).toBe("a draft's arrow: left as the draft drew it until you accept or discard it");
  });

  it('a second arrow between the same two cards runs in a lane of its own, alternately below and above the first, never over it', () => {
    expect(laneOf(0)).toEqual({ anchor: { x: 0.5, y: 0.5 }, precise: false });
    expect([1, 2, 3, 4, 5, 9].map((n) => laneOf(n).anchor.y)).toEqual([0.7, 0.3, 0.9, 0.1, 0.9, 0.9]);
    expect(laneOf(1).precise).toBe(true);
  });
});
