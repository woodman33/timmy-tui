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
// Imports nothing, so these rules run in Node's tests too (tests/studio-placement-model.test.ts).

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
