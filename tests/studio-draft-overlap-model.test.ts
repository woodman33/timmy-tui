/**
 * R8 (H158; open item J, the operator's decision of 2026-10-18, 01:15 PT: "Say so, offer to move it"): what a model's draft lands
 * on, in words, and where Move it to free space takes it (companion/studio-canvas/src/drafts.js draftGround, landsWords,
 * movedWords, movedMark, movedOf; ./placement.js landsOn, nearestSpot), run in Node on store records and boxes written by hand
 * (FIXTURES in tldraw's record shape: no editor runs here; the real page is exercised in Chromium by
 * tests/studio-draft-overlap-browser.test.ts). The boards made by the seeded generator below are FAKE as well.
 */
import { describe, expect, it } from 'vitest';
import { acceptPlan, draftGround, draftOf, landsWords, MOVE_LABEL, movedMark, movedOf, movedWords, pendingDrafts } from '../companion/studio-canvas/src/drafts.js';
import { landsOn, nearestSpot, overlapsAny, PLACE_MARGIN } from '../companion/studio-canvas/src/placement.js';

type Rec = Record<string, unknown> & { id: string; typeName: string };
type B = { minX: number; minY: number; maxX: number; maxY: number };
const D1 = 'draft-0a1b2c3d4e5f';
const D2 = 'draft-ffeeddccbbaa';
const mark = (id: string) => ({ timmyDraft: { id, job: 'turn-1', from: 3, at: '2026-10-18T01:00:00.000Z' } });
/** A FIXTURE shape: at `x`, `y` in its parent's space, `w` x `h`. */
const shape = (id: string, x: number, y: number, w: number, h: number, o: Partial<Rec> = {}): Rec => ({ id, typeName: 'shape', type: 'geo', parentId: 'page:p1', x, y, rotation: 0, props: { w, h }, meta: {}, ...o });
const page = (id: string): Rec => ({ id, typeName: 'page', name: id, meta: {} });
const arrowBinding = (id: string, fromId: string, toId: string): Rec => ({ id, typeName: 'binding', type: 'arrow', fromId, toId, props: {}, meta: {} });
const box = (x: number, y: number, w: number, h: number): B => ({ minX: x, minY: y, maxX: x + w, maxY: y + h });
const shift = (b: B, dx: number, dy: number): B => ({ minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy });
/** The page bounds of each FIXTURE shape, as tldraw gives them unrotated: its x and y added up its parents, its own w and h; a
 *  group's, its children's together. */
const boundsIn = (records: Rec[]) => {
  const byId = new Map(records.map((r) => [r.id, r]));
  const of = (id: string): B | null => {
    const r = byId.get(id);
    if (!r || r.typeName !== 'shape') return null;
    if (r.type === 'group') {
      const kids = records.filter((k) => k.parentId === id).map((k) => of(k.id)).filter((b): b is B => !!b);
      return kids.length ? { minX: Math.min(...kids.map((b) => b.minX)), minY: Math.min(...kids.map((b) => b.minY)), maxX: Math.max(...kids.map((b) => b.maxX)), maxY: Math.max(...kids.map((b) => b.maxY)) } : null;
    }
    let x = 0;
    let y = 0;
    for (let at: Rec | undefined = r; at && at.typeName === 'shape'; at = byId.get(String(at.parentId))) { x += Number(at.x); y += Number(at.y); }
    const p = r.props as { w: number; h: number };
    return box(x, y, p.w, p.h);
  };
  return of;
};
/** Whether `b` sits clear of every one of `boxes` by `m` (the placement rule: nothing placed covers a shape). */
const clearOf = (b: B, boxes: B[], m = PLACE_MARGIN): boolean => boxes.every((o) => b.maxX + m <= o.minX || b.minX >= o.maxX + m || b.maxY + m <= o.minY || b.minY >= o.maxY + m);

describe('what a draft lands on (R8 H158)', () => {
  // the board: the person's shapes, a group, another draft's shape, a shape on another page; draft D1: a box, and a frame with a
  // shape of its own inside it and one the person put there (it moves with the frame, so it is not under the draft)
  const records: Rec[] = [
    page('page:p1'), page('page:p2'),
    shape('shape:d-a', 100, 100, 160, 80, { meta: mark(D1) }),
    shape('shape:d-frame', 400, 100, 200, 150, { type: 'frame', meta: mark(D1) }),
    shape('shape:d-child', 20, 20, 50, 50, { parentId: 'shape:d-frame', meta: mark(D1) }),
    shape('shape:yours', 100, 60, 40, 40, { parentId: 'shape:d-frame' }),
    shape('shape:d-p2', 0, 0, 10, 10, { parentId: 'page:p2', meta: mark(D1) }),
    // under the box, and across its corner
    shape('shape:under-a', 120, 120, 40, 40),
    shape('shape:across', 90, 90, 30, 30),
    // touching the box's right edge only
    shape('shape:touch', 260, 100, 50, 50),
    // a group at the page's origin: one of its shapes is under the frame, the other far off; the group itself is its shapes
    shape('shape:group', 0, 0, 1, 1, { type: 'group' }),
    shape('shape:g1', 420, 200, 30, 30, { parentId: 'shape:group' }),
    shape('shape:g2', 900, 900, 10, 10, { parentId: 'shape:group' }),
    // another draft's shape, under the box: it is on the board too
    shape('shape:other', 110, 150, 20, 20, { meta: mark(D2) }),
    // the same place as the box, on another page
    shape('shape:elsewhere', 100, 100, 160, 80, { parentId: 'page:p2' }),
    shape('shape:far', 2000, 2000, 10, 10),
  ];
  const ground = draftGround(records, D1, boundsIn(records));

  it("counts the board's shapes its shapes overlap, by their page bounds, page by page: not its own, not one inside its own, not a group (its shapes count), not one that only touches, not one on another page; another draft's shape counts", () => {
    expect(ground.map((g) => g.page)).toEqual(['page:p1', 'page:p2']);
    const [p1, p2] = ground;
    expect(p1.own.map((o) => o.id).sort()).toEqual(['shape:d-a', 'shape:d-child', 'shape:d-frame']);
    // its top shapes, the ones a move moves (a shape inside its frame goes with the frame)
    expect(p1.tops.sort()).toEqual(['shape:d-a', 'shape:d-frame']);
    expect(p1.block).toEqual({ minX: 100, minY: 100, maxX: 600, maxY: 250 });
    expect(p1.board.map((s) => s.id).sort()).toEqual(['shape:across', 'shape:far', 'shape:g1', 'shape:g2', 'shape:other', 'shape:touch', 'shape:under-a']);
    expect(landsOn(p1.own, p1.board).sort()).toEqual(['shape:across', 'shape:g1', 'shape:other', 'shape:under-a']);
    expect(p2.own.map((o) => o.id)).toEqual(['shape:d-p2']);
    expect(p2.board.map((s) => s.id)).toEqual(['shape:elsewhere']);
    expect(landsOn(p2.own, p2.board)).toEqual([]);
    expect(landsWords(ground.reduce((n, g) => n + landsOn(g.own, g.board).length, 0))).toBe('This draft lands on 4 shapes already on the board.');
    // the other draft: on D1's box (on the board too) and the person's shape under both
    const other = draftGround(records, D2, boundsIn(records));
    expect(other.map((g) => landsOn(g.own, g.board).sort())).toEqual([['shape:d-a', 'shape:under-a']]);
    // a draft that is not on the board has no ground
    expect(draftGround(records, 'draft-000000000000', boundsIn(records))).toEqual([]);
  });

  it('an arrow of the draft that joins a shape of the board does not land on it (a link touches the shape it joins), but it does land on a shape it crosses; the move leaves such an arrow to follow what it joins', () => {
    const linked: Rec[] = [
      page('page:p1'),
      shape('shape:card', 300, 300, 100, 100),
      shape('shape:crossed', 250, 220, 20, 20),
      shape('shape:new', 0, 0, 160, 80, { meta: mark(D1) }),
      shape('shape:link', 160, 40, 140, 300, { type: 'arrow', meta: mark(D1) }),
      arrowBinding('binding:to-card', 'shape:link', 'shape:card'),
      arrowBinding('binding:to-new', 'shape:link', 'shape:new'),
    ];
    const [g] = draftGround(linked, D1, boundsIn(linked));
    expect(landsOn(g.own, g.board)).toEqual(['shape:crossed']);
    // the block a move moves clear is the draft's own content: the arrow that joins the board's card follows its bindings
    expect(g.block).toEqual({ minX: 0, minY: 0, maxX: 160, maxY: 80 });
    expect(g.tops.sort()).toEqual(['shape:link', 'shape:new']);
  });

  it('says it in words: nothing when it lands on nothing, the count when it does; and, once moved, from where and what it had landed on', () => {
    expect(landsWords(0)).toBeNull();
    expect(landsWords(1)).toBe('This draft lands on 1 shape already on the board.');
    expect(landsWords(3)).toBe('This draft lands on 3 shapes already on the board.');
    expect(MOVE_LABEL).toBe('Move it to free space');
    expect(movedWords({ x: 460, y: 220, over: 3 })).toBe('Moved to free space from x 460, y 220, where it landed on 3 shapes. It lands on no shape now.');
    expect(movedWords({ x: -12.6, y: 0.4, over: 1 })).toBe('Moved to free space from x -13, y 0, where it landed on 1 shape. It lands on no shape now.');
  });

  it("a move keeps the draft's mark (its id, job, revision and when) and says it was moved and from where; read back from the board; Accept keeps it in what it says of the proposal", () => {
    const m = draftOf(records[2])!;
    const moved = { x: 100, y: 100, over: 4, at: '2026-10-18T02:00:00.000Z' };
    expect(movedMark(m, moved)).toEqual({ id: D1, job: 'turn-1', from: 3, at: '2026-10-18T01:00:00.000Z', moved });
    const after = records.map((r) => (draftOf(r)?.id === D1 ? { ...r, meta: { ...(r.meta as object), timmyDraft: movedMark(draftOf(r)!, moved) } } : r));
    expect(movedOf(after, D1)).toEqual(moved);
    expect(movedOf(records, D1)).toBeNull();
    expect(movedOf(after, D2)).toBeNull();
    // still the same pending draft
    expect(pendingDrafts(after).map((d) => [d.id, d.job, d.from, d.at, d.shapes.length])).toEqual(pendingDrafts(records).map((d) => [d.id, d.job, d.from, d.at, d.shapes.length]));
    const accepted = acceptPlan(after, D1, '2026-10-18T02:05:00.000Z');
    expect((accepted[0].meta as Record<string, unknown>).timmyProposed).toEqual({ by: 'Timmy', draft: D1, job: 'turn-1', accepted: '2026-10-18T02:05:00.000Z', moved });
    expect(accepted.every((r) => draftOf(r) === null)).toBe(true);
  });
});

describe('where Move it to free space takes a draft (R8 H158)', () => {
  it('a block clear where it is stays there; one over a shape moves the least way that keeps it clear of every shape by the margin', () => {
    expect(nearestSpot(box(1000, 1000, 100, 100), [box(0, 0, 100, 100)])).toEqual({ dx: 0, dy: 0 });
    // over a shape: down 82 clears it (up 102, right 152, left 172)
    const block = box(100, 100, 160, 80);
    const boxes = [box(120, 110, 100, 40)];
    const to = nearestSpot(block, boxes);
    expect(to).toEqual({ dx: 0, dy: 82 });
    expect(overlapsAny(shift(block, to.dx, to.dy), boxes, PLACE_MARGIN)).toBe(false);
    expect(clearOf(shift(block, to.dx, to.dy), boxes)).toBe(true);
    // a corner place where shapes on two sides meet: between them, not past either. Under it, a shape below that one, a tall one
    // to its right, and the whole left side and the top taken: the corner below and to the right (192, 112: 222 away) is nearer
    // than going past the shape below (444) or the tall one (524), and the only place that near
    const walls = [box(100, 100, 160, 80), box(100, 212, 160, 300), box(292, -200, 300, 380), box(-1000, -1000, 1068, 2000), box(68, -1000, 224, 1068)];
    expect(clearOf(block, walls.slice(1))).toBe(true);
    const corner = nearestSpot(block, walls);
    expect(clearOf(shift(block, corner.dx, corner.dy), walls)).toBe(true);
    expect(corner).toEqual({ dx: 192, dy: 112 });
    // with the left side and the top open, three corners are as near: the higher, then the one more to the left, is taken
    const open = [box(100, 100, 160, 80), box(100, 212, 160, 300), box(292, -200, 300, 380), box(-400, 100, 368, 80), box(100, -400, 160, 468)];
    expect(nearestSpot(block, open)).toEqual({ dx: -192, dy: -112 });
  });

  it('the nearest of the clear places: no clear place on a fine grid around it is nearer, on FAKE boards a seeded generator makes; the same board gives the same move', () => {
    let seed = 7;
    const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
    for (let board = 0; board < 6; board++) {
      const boxes = Array.from({ length: 8 }, () => box(int(0, 600), int(0, 600), int(20, 160), int(20, 120)));
      const under = boxes[int(0, boxes.length - 1)];
      const block = box(under.minX + int(-20, 20), under.minY + int(-20, 20), int(40, 200), int(40, 140));
      const to = nearestSpot(block, boxes);
      expect(nearestSpot(block, boxes), `board ${board}: the same move`).toEqual(to);
      expect(clearOf(shift(block, to.dx, to.dy), boxes), `board ${board}: clear after the move`).toBe(true);
      const d = Math.hypot(to.dx, to.dy);
      let nearer: string | null = null;
      for (let dx = -900; dx <= 900 && !nearer; dx += 4) {
        for (let dy = -900; dy <= 900; dy += 4) {
          if (Math.hypot(dx, dy) < d - 1e-6 && clearOf(shift(block, dx, dy), boxes)) { nearer = `${dx},${dy}`; break; }
        }
      }
      expect(nearer, `board ${board}: a clear place nearer than (${to.dx}, ${to.dy})`).toBeNull();
    }
  });

  it('always finds a clear place (right of every shape is one), keeps every shape of the draft as it is arranged, and leaves malformed boxes out, never guessed', () => {
    const row = Array.from({ length: 30 }, (_, i) => box(i * 40, 0, 40, 400));
    const block = box(300, 100, 120, 80);
    const to = nearestSpot(block, row);
    expect(clearOf(shift(block, to.dx, to.dy), row)).toBe(true);
    // the draft's shapes all move by the same (dx, dy), so their arrangement is kept and none of them lands on the board's
    const own = [{ id: 'a', box: box(300, 100, 50, 30), joins: [] }, { id: 'b', box: box(370, 150, 50, 30), joins: [] }];
    const board = row.map((b, i) => ({ id: `r${i}`, box: b }));
    expect(landsOn(own, board).length).toBeGreaterThan(0);
    expect(landsOn(own.map((o) => ({ ...o, box: shift(o.box, to.dx, to.dy) })), board)).toEqual([]);
    expect(nearestSpot(block, [{ minX: NaN, minY: 0, maxX: 1, maxY: 1 } as B, box(300, 100, 10, 10)])).toEqual(nearestSpot(block, [box(300, 100, 10, 10)]));
    expect(nearestSpot({ minX: 0, minY: 0, maxX: NaN, maxY: 1 } as B, row)).toEqual({ dx: 0, dy: 0 });
  });
});
