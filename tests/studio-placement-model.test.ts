/**
 * R7 (H151; H147's R6 finding 5, REMAINING-DEFECTS row 10: "placed cards cover existing shapes", review/H147/caps/studio/
 * 24-image-added.png): where Timmy places what it adds to the board (companion/studio-canvas/src/placement.js freeSpot, pure):
 * a place where the new block overlaps no existing shape (their page bounds plus a margin), found in a fixed order of candidate
 * places, the visible area beside the panel first (top to bottom, then left to right), then just right of it, and at last right
 * of everything. The boxes here are FAKE (written by this test).
 */
import { describe, expect, it } from 'vitest';
import { freeSpot, overlapsAny, PLACE_MARGIN } from '../companion/studio-canvas/src/placement.js';

type B = { minX: number; minY: number; maxX: number; maxY: number };
const box = (x: number, y: number, w: number, h: number): B => ({ minX: x, minY: y, maxX: x + w, maxY: y + h });
const area = { x: 300, y: 100, w: 1000, h: 600 };
const clear = (at: { x: number; y: number }, size: { w: number; h: number }, boxes: B[], m = PLACE_MARGIN): boolean =>
  boxes.every((b) => at.x + size.w + m <= b.minX || at.x >= b.maxX + m || at.y + size.h + m <= b.minY || at.y >= b.maxY + m);

describe('where Timmy places on the board (R7 H151)', () => {
  it('an empty board: the visible area\'s top-left corner (beside the panel, under the menu)', () => {
    expect(freeSpot([], { w: 320, h: 200 }, area)).toEqual({ x: 300, y: 100, inArea: true });
  });

  it('never over a shape: a shape where the old rule put the card (the area\'s middle, or right of the rightmost card) is kept clear by the margin', () => {
    const size = { w: 320, h: 200 };
    // a shape over where the old rule put the first card (the middle of the area: 640, 300), one at the area's top-left, and one
    // right of it (where the old rule put the next card: right of the rightmost, 32 px on)
    const middle = box(500, 330, 300, 150);
    const boxes = [box(300, 100, 400, 180), middle, box(740, 100, 200, 120)];
    const at = freeSpot(boxes, size, area);
    expect(at.inArea).toBe(true);
    expect(clear(at, size, boxes)).toBe(true);
    expect(overlapsAny({ minX: at.x, minY: at.y, maxX: at.x + size.w, maxY: at.y + size.h }, boxes, PLACE_MARGIN)).toBe(false);
    // the first such place in reading order: the top row is taken up to x 940 (+ the margin), so it is on that row, right of them
    expect(at).toEqual({ x: 972, y: 100, inArea: true });
    // the old rule's middle place is not clear: it would have covered the shape there
    expect(clear({ x: 640, y: 300 }, size, boxes)).toBe(false);
  });

  it('in a fixed order: the same board gives the same place, and blocks placed one after another never cover each other', () => {
    const size = { w: 300, h: 180 };
    const boxes: B[] = [box(500, 300, 200, 200)];
    const placed: B[] = [];
    const where: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      const at = freeSpot([...boxes, ...placed], size, area);
      expect(freeSpot([...boxes, ...placed], size, area)).toEqual(at);
      const b = box(at.x, at.y, size.w, size.h);
      expect(overlapsAny(b, [...boxes, ...placed], PLACE_MARGIN), `block ${i} at ${JSON.stringify(at)}`).toBe(false);
      placed.push(b);
      where.push(at.inArea);
    }
    // the visible area first, while a place in it is clear (each of those inside it); once none is, just right of it
    const inside = where.indexOf(false);
    expect(inside).toBeGreaterThanOrEqual(2);
    expect(where.slice(inside).every((w) => !w)).toBe(true);
    expect(placed.slice(0, inside).every((b) => b.minX >= area.x && b.maxX <= area.x + area.w && b.minY >= area.y && b.maxY <= area.y + area.h)).toBe(true);
    expect(placed.slice(inside).every((b) => b.minX >= area.x + area.w)).toBe(true);
  });

  it('a board whose visible area is full: just right of the area first, else right of everything; always clear', () => {
    const size = { w: 260, h: 160 };
    const wall = [box(300, 100, 1000, 600)];
    const at = freeSpot(wall, size, area);
    expect(at.inArea).toBe(false);
    expect(clear(at, size, wall)).toBe(true);
    expect(at).toEqual({ x: 1300 + PLACE_MARGIN, y: 100, inArea: false });
    // a shape far to the right on every row: right of everything
    const far = [...wall, box(1300, -5000, 4000, 12000)];
    const there = freeSpot(far, size, area);
    expect(clear(there, size, far)).toBe(true);
    expect(there).toEqual({ x: 5300 + PLACE_MARGIN, y: 100, inArea: false });
  });

  it('a block larger than the visible area still finds a clear place; malformed boxes are left out, never guessed', () => {
    const big = { w: 2000, h: 1500 };
    const boxes = [box(300, 100, 100, 100), { minX: NaN, minY: 0, maxX: 1, maxY: 1 } as B];
    const at = freeSpot(boxes, big, area);
    expect(at.inArea).toBe(false);
    expect(clear(at, big, [boxes[0]])).toBe(true);
  });
});
