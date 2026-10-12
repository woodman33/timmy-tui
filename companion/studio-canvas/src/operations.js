// Round R4 (H100): Timmy Canvas and operations. An operation is one request (a command typed in the REPL, a board or canvas
// action, a `timmy act` call); everything it makes names it (src/ops/context.ts). The project API (src/studio/project-cards.ts)
// gives each card the operation its own record names, read from that record at each reading, and lists the operations, each
// as its own record says it, with its cards in the order they ran. This module holds the page's own rules for them, pure, so
// they run in Node's tests too (tests/canvas-operations-model.test.ts):
//   - the words a card shows for its operation (operationLine);
//   - the Project panel's groups by operation (groupByOperation);
//   - "Place this operation": what one press places and what it leaves alone, decided before anything is drawn
//     (placementPlan), where the new cards go (rowLayout), the page's record of it (readPlacement) and the words (placementWords).
// Nothing here imports anything.

/** An operation's id: o and 8 hex digits (src/ops/context.ts). */
export const OPERATION_ID = /^o[0-9a-f]{8}$/;
/** Where a page keeps what "Place this operation" placed on it: its meta, under this key, by project and operation. */
export const PLACEMENTS = 'timmyOperations';
/** The room between two cards of an operation's row: an arrow fits between them. */
export const ROW_GAP = 72;

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isOp = (v) => typeof v === 'string' && OPERATION_ID.test(v);

/** The words a card shows for its operation: "operation o1a2b3c4d", or "no operation: <why>", from the reading's words. */
export function operationLine(id, from) {
  if (isOp(id)) return `operation ${id}`;
  return `no operation: ${one(from) || 'its record names none'}`;
}

/**
 * The Project panel's groups by operation. `api`: a reading of the project (its cards, each with the operation its record
 * names, and its operations, running first, then the newest). Each operation the cards name is a group, in the reading's
 * order (one the reading does not list comes after, said as not listed), its cards in the order they ran; the cards that
 * name none go to `rest`, in the panel's kind order (`kinds`).
 */
export function groupByOperation(api, kinds = []) {
  const cards = Array.isArray(api && api.cards) ? api.cards.filter((c) => c && typeof c.id === 'string') : [];
  const listed = new Map();
  (Array.isArray(api && api.operations) ? api.operations : []).forEach((o, i) => { if (o && isOp(o.id) && !listed.has(o.id)) listed.set(o.id, { op: o, index: i }); });
  const named = new Map();
  for (const c of cards) {
    if (!isOp(c.operation)) continue;
    if (!named.has(c.operation)) named.set(c.operation, []);
    named.get(c.operation).push(c);
  }
  const time = (c) => { const t = typeof c.at === 'string' ? Date.parse(c.at) : Number.NaN; return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY; };
  const groups = [...named.entries()].map(([id, mine]) => {
    const l = listed.get(id);
    const op = l ? l.op : { id, request: null, state: 'not listed', note: 'the reading lists no record of it', cards: [] };
    const pos = new Map((Array.isArray(op.cards) ? op.cards : []).map((cid, i) => [cid, i]));
    const at = (c) => (pos.has(c.id) ? pos.get(c.id) : Number.POSITIVE_INFINITY);
    const sorted = [...mine].sort((a, b) => (at(a) - at(b)) || (time(a) - time(b)) || 0);
    return { op, cards: sorted, index: l ? l.index : Number.POSITIVE_INFINITY };
  }).sort((a, b) => (a.index - b.index) || 0).map(({ op, cards: c }) => ({ op, cards: c }));
  const order = (c) => { const i = kinds.indexOf(c.kind); return i < 0 ? kinds.length : i; };
  const rest = cards.filter((c) => !isOp(c.operation)).map((c, i) => ({ c, i })).sort((a, b) => order(a.c) - order(b.c) || a.i - b.i).map((x) => x.c);
  return { groups, rest };
}

/** The key a page's meta keeps one operation's placement under: the project's id and the operation's. */
export const placementKey = (projectId, opId) => `${String(projectId)}:${String(opId)}`;

/**
 * A page's record of one operation's placements, as its meta holds it, checked field by field (anything else is dropped):
 * the cards it placed (card id and shape id) and the arrows it drew (between two cards, and the arrow's shape id).
 */
export function readPlacement(value) {
  const o = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const shape = (s) => typeof s === 'string' && s.startsWith('shape:') && s.length <= 200;
  const card = (s) => typeof s === 'string' && s.length > 0 && s.length <= 600;
  const placed = (Array.isArray(o.placed) ? o.placed : []).filter((p) => p && card(p.card) && shape(p.shape)).map((p) => ({ card: p.card, shape: p.shape }));
  const links = (Array.isArray(o.links) ? o.links : []).filter((l) => l && card(l.from) && card(l.to) && shape(l.arrow)).map((l) => ({ from: l.from, to: l.to, arrow: l.arrow }));
  return { placed, links };
}

/**
 * What one press of "Place this operation" does on this page, decided before anything is drawn.
 *   op        the operation as the reading lists it ({ id, cards: [card ids, in the order they ran] })
 *   cards     the reading's cards, by id (a Map)
 *   drawable  (kind) => whether a card of that kind has a drawn card
 *   kept      this page's record of the operation's earlier placements (readPlacement), or null
 *   exists    (shape id) => whether that shape is on the canvas now
 * Returns:
 *   order     the cards with a drawn card, in the order they ran
 *   place     the cards to place now: never placed for this operation on this page
 *   already   [{ card, shape }] placed before and still there: left as they are (where the person moved or sized them)
 *   deleted   the cards placed before whose shape is gone: not placed again (deleting one is the person's edit too)
 *   skipped   the operation's cards with no drawn card, or not in the reading now
 *   links     [{ from, to }] the arrows to draw now: between cards next to each other in the order they ran, both on the
 *             page after this press, with no arrow drawn between them before
 *   linked    [{ from, to, arrow }] arrows drawn before and still there
 *   cut       [{ from, to, arrow }] arrows drawn before and deleted since: not drawn again
 */
export function placementPlan(op, cards, drawable, kept, exists) {
  const k = kept ? readPlacement(kept) : { placed: [], links: [] };
  const ids = Array.isArray(op && op.cards) ? op.cards.filter((x) => typeof x === 'string') : [];
  const order = [];
  const skipped = [];
  for (const id of ids) {
    const c = cards.get(id);
    if (c && drawable(c.kind) && !order.includes(id)) order.push(id); else if (!skipped.includes(id) && !order.includes(id)) skipped.push(id);
  }
  const before = new Map();
  for (const p of k.placed) if (!before.has(p.card)) before.set(p.card, p.shape);
  const place = [];
  const already = [];
  const deleted = [];
  for (const id of order) {
    if (!before.has(id)) { place.push(id); continue; }
    const shape = before.get(id);
    if (exists(shape)) already.push({ card: id, shape }); else deleted.push(id);
  }
  const onPage = new Set([...place, ...already.map((a) => a.card)]);
  const links = [];
  const linked = [];
  const cut = [];
  for (let i = 0; i + 1 < order.length; i++) {
    const from = order[i];
    const to = order[i + 1];
    const was = k.links.find((l) => l.from === from && l.to === to);
    if (was) { if (exists(was.arrow)) linked.push(was); else cut.push(was); continue; }
    if (onPage.has(from) && onPage.has(to)) links.push({ from, to });
  }
  return { order, place, already, deleted, skipped, links, linked, cut };
}

/** Where each card placed now goes: one row from `start`, left to right in the order given, `gap` between them. */
export function rowLayout(ids, start, widthOf, gap = ROW_GAP) {
  let x = Number(start.x) || 0;
  const y = Math.round(Number(start.y) || 0);
  return ids.map((id) => {
    const at = { card: id, x: Math.round(x), y };
    x += Math.max(1, Number(widthOf(id)) || 0) + gap;
    return at;
  });
}

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a press did, in words: the operation, what was placed and linked, and what was left as the person left it. */
export function placementWords(id, r) {
  const first = r.already.length === 0 && r.deleted.length === 0 && r.linked.length === 0 && r.cut.length === 0;
  const parts = [];
  const arrows = r.drawn ?? r.links.length;
  if (first) {
    parts.push(r.place.length ? `${count(r.place.length, 'card')} placed left to right in the order they ran${arrows ? `, linked by ${count(arrows, 'arrow')}` : ''}` : 'no card to place');
  } else {
    parts.push(r.place.length ? `${count(r.place.length, 'card')} added${arrows ? ` and linked by ${count(arrows, 'arrow')}` : ''}` : arrows ? `${count(arrows, 'arrow')} drawn` : 'nothing added');
    if (r.already.length) parts.push(`${count(r.already.length, 'card')} already placed for it, left as ${r.already.length === 1 ? 'it is' : 'they are'}`);
    if (r.deleted.length) parts.push(`${count(r.deleted.length, 'card')} you deleted not placed again (Place card in the list places one)`);
    if (r.cut.length) parts.push(`${count(r.cut.length, 'arrow')} you deleted not drawn again`);
  }
  if (r.skipped.length) parts.push(`${count(r.skipped.length, 'record')} with no drawn card left out`);
  return `Operation ${id}: ${parts.join('; ')}.`;
}
