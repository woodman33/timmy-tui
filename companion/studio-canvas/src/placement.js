// R7 (H151; H147's R6 finding 5, REMAINING-DEFECTS row 10: "placed cards cover existing shapes", the operator's order of
// 2026-10-16: "non-overlapping Studio cards"): where Timmy puts what it places on the board, for every way it places (project
// cards, drawn cards, an operation's cards, artifact cards, reference images, nodes: canvas.js placeAt, which they all call).
//
// The new block goes where it overlaps no shape already on the page: none of their page bounds, kept a margin (PLACE_MARGIN)
// away. The candidate places come in a fixed order, so the same board gives the same place: inside the visible area beside
// Timmy's panel first, row by row from the top and left to right along each row (its corners and the places right of and
// below each shape, and left of and above them); then just right of the visible area, on its rows; and, when nothing there is
// clear, right of everything on the page, which always is. The caller then brings it into view (canvas.js reveal).
//
// Imports nothing, so these rules run in Node's tests too (tests/studio-placement-model.test.ts; R8 H158: and
// tests/studio-draft-overlap-model.test.ts for what a draft lands on and where Move it to free space takes it).

/** The gap kept between a placed block and every shape already on the page (page units). */
export const PLACE_MARGIN = 32;

const finite = (b) => !!b && [b.minX, b.minY, b.maxX, b.maxY].every((v) => typeof v === 'number' && Number.isFinite(v)) && b.maxX >= b.minX && b.maxY >= b.minY;

/** Whether box `b` comes within `margin` of any of `boxes` (each { minX, minY, maxX, maxY }, page units). */
export function overlapsAny(b, boxes, margin = PLACE_MARGIN) {
  return boxes.filter(finite).some((o) => !(b.maxX + margin <= o.minX || b.minX >= o.maxX + margin || b.maxY + margin <= o.minY || b.minY >= o.maxY + margin));
}

/**
 * Where a block of `size` ({ w, h }, page units) goes among `boxes` (the page bounds of the shapes on the page), with `area` the
 * visible area beside the panel in page units ({ x, y, w, h }). Returns its top-left corner and whether it is inside that area
 * ({ x, y, inArea }); the caller brings it into view when it is not.
 */
export function freeSpot(boxes, size, area, o = {}) {
  const m = Number.isFinite(o.margin) ? o.margin : PLACE_MARGIN;
  const w = Math.max(1, Number(size && size.w) || 1);
  const h = Math.max(1, Number(size && size.h) || 1);
  const bs = (Array.isArray(boxes) ? boxes : []).filter(finite);
  const right = area.x + area.w;
  const bottom = area.y + area.h;
  const clear = (x, y) => bs.every((b) => x + w + m <= b.minX || x >= b.maxX + m || y + h + m <= b.minY || y >= b.maxY + m);
  const sorted = (vs) => [...new Set(vs.filter(Number.isFinite).map((v) => Math.round(v)))].sort((p, q) => p - q);
  // the places a block can sit against: the area's own edge, and each shape's four sides, the margin away
  const xs = sorted([area.x, ...bs.map((b) => b.maxX + m), ...bs.map((b) => b.minX - m - w)]);
  const ys = sorted([area.y, ...bs.map((b) => b.maxY + m), ...bs.map((b) => b.minY - m - h)]);
  // 1. inside the visible area, row by row
  for (const y of ys) {
    if (y < area.y - 0.5 || y + h > bottom + 0.5) continue;
    for (const x of xs) {
      if (x < area.x - 0.5 || x + w > right + 0.5) continue;
      if (clear(x, y)) return { x, y, inArea: true };
    }
  }
  // 2. just right of it (up to one more area's width), on its rows (its top row only, for a block taller than the area)
  const rows = h > area.h ? [Math.round(area.y)] : ys.filter((y) => y >= area.y - 0.5 && y + h <= bottom + 0.5);
  const cols = sorted([right, ...bs.map((b) => b.maxX + m)]).filter((x) => x >= right - 0.5 && x <= right + area.w + 0.5);
  for (const y of rows) {
    for (const x of cols) if (clear(x, y)) return { x, y, inArea: false };
  }
  // 3. right of everything on the page, at the area's top: clear of every shape by the margin
  const far = Math.round(Math.max(right, ...bs.map((b) => b.maxX)) + m);
  return { x: far, y: Math.round(area.y), inArea: false };
}

// R8 (H158; open item J, the operator's decision of 2026-10-18, 01:15 PT: "Say so, offer to move it"): a model's draft that lands
// on shapes already on the board. What it lands on is counted by page bounds (landsOn); Move it to free space takes it, whole, to
// the nearest place where the rule above holds (nearestSpot: nothing placed covers a shape, the margin kept). ./drafts.js says it
// in words; canvas.js draws it and moves it.

/** Whether boxes `a` and `b` overlap: they share some area (two boxes that only touch at an edge do not). */
export function overlaps(a, b) {
  return finite(a) && finite(b) && a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/**
 * The ids of the board's shapes (`board`: { id, box }) that any of `own` ({ box, joins }: a draft's shapes, by their page bounds)
 * overlaps, in the board's order. A shape a draft's arrow joins (`joins`: the ids it is bound to) is not landed on by that arrow:
 * a link touches the shape it joins.
 */
export function landsOn(own, board) {
  const mine = (Array.isArray(own) ? own : []).filter((o) => o && finite(o.box));
  return (Array.isArray(board) ? board : []).filter((s) => s && finite(s.box) && mine.some((o) => !(o.joins || []).includes(s.id) && overlaps(o.box, s.box))).map((s) => s.id);
}

/**
 * How far a block already on the board (`block`: its page bounds) moves to the nearest place where it is clear of every one of
 * `boxes` by the margin. Its candidate places are where it is, and against each box's four sides the margin away (left of it,
 * right of it, above it, below it), on its own row and column and where those cross: the nearest place free of the boxes is one
 * of them. The nearest clear one is taken (the shortest move; then the smaller move up or down; then the higher, then the one more
 * to the left), so the same board gives the same move; right of every box is always clear. { dx, dy }: 0 and 0 when it is clear
 * where it is (and for a malformed block, which is never guessed at).
 */
export function nearestSpot(block, boxes, o = {}) {
  const m = Number.isFinite(o.margin) ? o.margin : PLACE_MARGIN;
  if (!finite(block)) return { dx: 0, dy: 0 };
  const bs = (Array.isArray(boxes) ? boxes : []).filter(finite);
  const w = block.maxX - block.minX;
  const h = block.maxY - block.minY;
  const x0 = block.minX;
  const y0 = block.minY;
  const clear = (x, y) => bs.every((b) => x + w + m <= b.minX || x >= b.maxX + m || y + h + m <= b.minY || y >= b.maxY + m);
  if (clear(x0, y0)) return { dx: 0, dy: 0 };
  const EPS = 1e-9;
  const near = (v0) => (p, q) => Math.abs(p - v0) - Math.abs(q - v0) || p - q;
  const xs = [...new Set([x0, ...bs.map((b) => b.maxX + m), ...bs.map((b) => b.minX - m - w)])].sort(near(x0));
  const ys = [...new Set([y0, ...bs.map((b) => b.maxY + m), ...bs.map((b) => b.minY - m - h)])].sort(near(y0));
  // right of every box, on its own row: always clear, so never farther than that
  let best = { x: Math.max(...bs.map((b) => b.maxX)) + m, y: y0 };
  let dist = best.x - x0;
  const better = (x, y, d) => {
    if (d < dist - EPS) return true;
    if (d > dist + EPS) return false;
    const ay = Math.abs(y - y0);
    const by = Math.abs(best.y - y0);
    if (ay !== by) return ay < by;
    return y !== best.y ? y < best.y : x < best.x;
  };
  // nearest first, along each axis: once a candidate is farther than the best clear one, every one after it is too
  for (const x of xs) {
    const ax = Math.abs(x - x0);
    if (ax > dist + EPS) break;
    for (const y of ys) {
      const d = Math.hypot(ax, y - y0);
      if (d > dist + EPS) break;
      if (better(x, y, d) && clear(x, y)) { best = { x, y }; dist = d; }
    }
  }
  return { dx: best.x - x0, dy: best.y - y0 };
}
