/**
 * Round R4 (H100): Timmy Canvas's own rules for operations (companion/studio-canvas/src/operations.js), run here in Node: the
 * words a card shows for its operation, the Project panel's groups by operation, and what one press of "Place this operation"
 * places and leaves alone. The page itself runs in a real Chromium in tests/studio-operation-browser.test.ts.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the page's module is plain JavaScript, bundled for the browser
import { groupByOperation, isTimmyArrow, OPERATION_ID, operationLine, placementKey, placementPlan, placementWords, readPlacement, removalWords, ROW_GAP, rowLayout } from '../companion/studio-canvas/src/operations.js';

type Card = { id: string; kind: string; operation?: string | null; operationFrom?: string; at?: string | null };
type Plan = { order: string[]; place: string[]; already: Array<{ card: string; shape: string }>; deleted: string[]; skipped: string[]; links: Array<{ from: string; to: string }>; linked: unknown[]; cut: unknown[]; gone: unknown[] };
/** R4 (H109): what a press that added anything says after its words. */
const AS_WAS = ' Your selection is as it was; one undo takes this placement back.';

const OP = 'oa1b2c3d4';
const OTHER = 'ob2c3d4e5';
const KINDS = ['workflow', 'params', 'flow', 'vox', 'run', 'unreadable'];
const drawable = (kind: string): boolean => kind !== 'unreadable';
const cards = (list: Card[]): Map<string, Card> => new Map(list.map((c) => [c.id, c]));
const A = { id: 'workflow:RUN.md', kind: 'workflow', operation: OP, at: '2026-10-11T10:00:00.000Z' };
const B = { id: 'flow:fa1b2c3d4', kind: 'flow', operation: OP, at: '2026-10-11T10:01:00.000Z' };
const C = { id: 'vox:va1b2c3d4', kind: 'vox', operation: OP, at: '2026-10-11T10:02:00.000Z' };
const D = { id: 'run:agent:r1', kind: 'run', operation: OP, at: '2026-10-11T10:03:00.000Z' };

describe('Timmy Canvas and operations', () => {
  it('a card says its operation, or that none is named and why', () => {
    expect(OPERATION_ID.test(OP)).toBe(true);
    expect(operationLine(OP, 'its flow record')).toBe(`operation ${OP}`);
    expect(operationLine(null, 'its flow record names none')).toBe('no operation: its flow record names none');
    expect(operationLine(undefined, '')).toBe('no operation: its record names none');
    // only an operation id is an operation (no markup, no other id)
    expect(operationLine('o1234', 'x')).toBe('no operation: x');
    expect(operationLine('<b>oa1b2c3d4</b>', 'x')).toBe('no operation: x');
  });

  it("groups the panel's cards by operation in the reading's order, each in the order its cards ran; the rest by kind", () => {
    const rest = [{ id: 'run:chat:1', kind: 'run', operation: null }, { id: 'params:x', kind: 'params', operation: null }, { id: 'unreadable:y', kind: 'unreadable', operation: null }];
    const orphan = { id: 'vox:vb2c3d4e5', kind: 'vox', operation: 'oc3d4e5f6', at: '2026-10-11T08:00:00.000Z' };
    const api = {
      cards: [C, ...rest, A, { id: 'flow:f2', kind: 'flow', operation: OTHER, at: '2026-10-11T09:00:00.000Z' }, B, orphan],
      operations: [{ id: OTHER, state: 'running', cards: ['flow:f2'] }, { id: OP, state: 'succeeded', request: '/run RUN.md build', cards: [A.id, B.id, C.id] }],
    };
    const { groups, rest: left } = groupByOperation(api, KINDS);
    expect(groups.map((g: { op: { id: string } }) => g.op.id)).toEqual([OTHER, OP, 'oc3d4e5f6']);
    expect(groups[1].cards.map((c: Card) => c.id)).toEqual([A.id, B.id, C.id]);
    // an operation the reading does not list is still a group, said as not listed
    expect(groups[2].op).toMatchObject({ id: 'oc3d4e5f6', request: null, state: 'not listed' });
    expect(left.map((c: Card) => c.id)).toEqual(['params:x', 'run:chat:1', 'unreadable:y']);
    expect(groupByOperation({ cards: [], operations: [] }, KINDS)).toEqual({ groups: [], rest: [] });
    expect(groupByOperation(null, KINDS)).toEqual({ groups: [], rest: [] });
  });

  it('a first press places every card that draws, in the order they ran, each linked to the next; an unreadable or missing one is left out and said', () => {
    const op = { id: OP, cards: [A.id, B.id, 'unreadable:z', C.id, 'flow:gone'] };
    const plan = placementPlan(op, cards([A, B, C, { id: 'unreadable:z', kind: 'unreadable', operation: OP }]), drawable, null, () => false) as Plan;
    expect(plan.order).toEqual([A.id, B.id, C.id]);
    expect(plan.place).toEqual([A.id, B.id, C.id]);
    expect(plan.skipped).toEqual(['unreadable:z', 'flow:gone']);
    expect(plan.links).toEqual([{ from: A.id, to: B.id }, { from: B.id, to: C.id }]);
    expect([plan.already, plan.deleted, plan.linked, plan.cut, plan.gone]).toEqual([[], [], [], [], []]);
    // R4 (H109): nothing it placed is selected, and one undo takes it back: the words say both
    expect(placementWords(OP, { ...plan, drawn: 2 })).toBe(`Operation ${OP}: 3 cards placed left to right in the order they ran, linked by 2 arrows; 2 records with no drawn card left out.${AS_WAS}`);
  });

  it('a second press adds no duplicate: what is there is left as it is (moved or resized), a deleted card or arrow is not placed again, and what ran since is added and linked', () => {
    const op = { id: OP, cards: [A.id, B.id, C.id, D.id] };
    const kept = {
      placed: [{ card: A.id, shape: 'shape:a' }, { card: B.id, shape: 'shape:b' }, { card: C.id, shape: 'shape:c' }],
      links: [{ from: A.id, to: B.id, arrow: 'shape:ab' }, { from: B.id, to: C.id, arrow: 'shape:bc' }],
    };
    // nothing new, nothing deleted
    const there = new Set(['shape:a', 'shape:b', 'shape:c', 'shape:ab', 'shape:bc']);
    const same = placementPlan({ id: OP, cards: [A.id, B.id, C.id] }, cards([A, B, C]), drawable, kept, (s: string) => there.has(s)) as Plan;
    expect(same.place).toEqual([]);
    expect(same.already).toEqual([{ card: A.id, shape: 'shape:a' }, { card: B.id, shape: 'shape:b' }, { card: C.id, shape: 'shape:c' }]);
    expect(same.links).toEqual([]);
    // a press that adds nothing says nothing of the selection or of undo (it writes nothing: ./cards.js placeOperation)
    expect(placementWords(OP, { ...same, drawn: 0 })).toBe(`Operation ${OP}: nothing added; 3 cards already placed for it, left as they are.`);
    // only the arrow from B to C deleted by the person (both its cards still there): not drawn again, said as theirs
    const cutOnly = placementPlan({ id: OP, cards: [A.id, B.id, C.id] }, cards([A, B, C]), drawable, kept, (s: string) => s !== 'shape:bc' && there.has(s)) as Plan;
    expect(cutOnly.cut).toEqual([{ from: B.id, to: C.id, arrow: 'shape:bc' }]);
    expect(cutOnly.gone).toEqual([]);
    expect(placementWords(OP, { ...cutOnly, drawn: 0 })).toBe(`Operation ${OP}: nothing added; 3 cards already placed for it, left as they are; 1 arrow you deleted not drawn again.`);
    // a run since (D); the person deleted card B, and R4 (H109) the arrows Timmy drew to and from it went with it
    there.delete('shape:b');
    there.delete('shape:ab');
    there.delete('shape:bc');
    const next = placementPlan(op, cards([A, B, C, D]), drawable, kept, (s: string) => there.has(s)) as Plan;
    expect(next.place).toEqual([D.id]);
    expect(next.deleted).toEqual([B.id]);
    expect(next.already.map((x) => x.card)).toEqual([A.id, C.id]);
    expect(next.linked).toEqual([]);
    expect(next.cut).toEqual([]);
    expect(next.gone).toEqual([{ from: A.id, to: B.id, arrow: 'shape:ab' }, { from: B.id, to: C.id, arrow: 'shape:bc' }]);
    // D follows C (both on the page): one new arrow; nothing is drawn to or from the deleted B
    expect(next.links).toEqual([{ from: C.id, to: D.id }]);
    expect(placementWords(OP, { ...next, drawn: 1 })).toBe(`Operation ${OP}: 1 card added and linked by 1 arrow; 2 cards already placed for it, left as they are; 1 card you deleted not placed again, nor the 2 arrows that went with it (Place card in the list places one).${AS_WAS}`);
    // a new card whose card before it was deleted is placed, unlinked
    const after = placementPlan({ id: OP, cards: [A.id, B.id, D.id] }, cards([A, B, D]), drawable, { placed: kept.placed.slice(0, 2), links: kept.links.slice(0, 1) }, (s: string) => there.has(s)) as Plan;
    expect(after.place).toEqual([D.id]);
    expect(after.links).toEqual([]);
  });

  it("R4 (H109): tells Timmy's placement arrows from a person's, and says what went with a deleted card (only when Timmy removed something)", () => {
    expect(isTimmyArrow({ type: 'arrow', meta: { timmyOperation: OP } })).toBe(true);
    // a person's arrow, an agent's arrow (its job, not an operation) and anything that is not an arrow are not
    expect(isTimmyArrow({ type: 'arrow', meta: {} })).toBe(false);
    expect(isTimmyArrow({ type: 'arrow', meta: { timmyJob: 'canvas-1' } })).toBe(false);
    expect(isTimmyArrow({ type: 'arrow', meta: { timmyOperation: 'o123' } })).toBe(false);
    expect(isTimmyArrow({ type: 'timmy-result', meta: { timmyOperation: OP } })).toBe(false);
    expect(isTimmyArrow(null)).toBe(false);
    expect(removalWords(['Flow fa1b2c3d4'], 2, 0)).toBe('Deleted the card "Flow fa1b2c3d4"; Timmy removed with it the 2 arrows it had drawn to or from it. One undo brings back all that went.');
    expect(removalWords(['A', 'B'], 1, 1)).toBe('Deleted 2 cards; Timmy removed with them the 1 arrow it had drawn to or from them. 1 arrow you drew stays where it ends. One undo brings back all that went.');
    expect(removalWords(['x'.repeat(80)], 1, 2)).toBe(`Deleted the card "${'x'.repeat(59)}…"; Timmy removed with it the 1 arrow it had drawn to or from it. 2 arrows you drew stay where they end. One undo brings back all that went.`);
    // Timmy removed nothing: no words
    expect(removalWords(['A'], 0, 3)).toBeNull();
  });

  it("reads a page's record field by field, keyed by project and operation, and lays a row out left to right", () => {
    expect(placementKey('abcdef0123456789', OP)).toBe(`abcdef0123456789:${OP}`);
    expect(readPlacement({ placed: [{ card: A.id, shape: 'shape:a' }, { card: A.id, shape: 'not-a-shape' }, null, { card: '', shape: 'shape:x' }], links: [{ from: A.id, to: B.id, arrow: 'shape:ab' }, { from: A.id, to: B.id }], extra: 1 }))
      .toEqual({ placed: [{ card: A.id, shape: 'shape:a' }], links: [{ from: A.id, to: B.id, arrow: 'shape:ab' }] });
    expect(readPlacement('nonsense')).toEqual({ placed: [], links: [] });
    const widths: Record<string, number> = { [A.id]: 380, [B.id]: 380, [C.id]: 360 };
    expect(rowLayout([A.id, B.id, C.id], { x: 10.4, y: 20.6 }, (id: string) => widths[id])).toEqual([
      { card: A.id, x: 10, y: 21 }, { card: B.id, x: Math.round(10.4 + 380 + ROW_GAP), y: 21 }, { card: C.id, x: Math.round(10.4 + 2 * (380 + ROW_GAP)), y: 21 },
    ]);
  });
});
