// R5 (H133): drafts. What Timmy proposes for the board arrives as a draft the person accepts or discards (the operator's order
// of 2026-10-15: "Timmy can propose and arrange board content through its supported AI/backend interface; users can review,
// accept or discard drafts. Accepting a canvas draft must not secretly execute native edits").
//
// How it works, on the agent's existing bridge (canvas.js runs the call; src/studio/bridge.ts carries it):
//   - an exec flagged as a draft runs as any canvas call does, and every shape and asset it creates carries the draft's mark
//     (meta.timmyDraft: its id, the job, the revision it was made from, when). The page outlines a pending draft in amber,
//     dashed, labelled DRAFT · proposed by Timmy, and lists it in its side panel with Accept and Discard;
//   - a draft only adds: a call that changes or removes what is already on the board (anything but a pending draft's own
//     shapes), or adds a page, keeps nothing and says why (draftRefusal);
//   - a draft made from a revision the canvas has left (the person or another call changed it after Timmy read it) is refused
//     before its code runs, and says so (staleWords);
//   - Accept clears the mark (the shapes stay; meta.timmyProposed keeps who proposed them and when they were accepted); Discard
//     removes the draft's shapes and assets (shapes of the person's own inside them are moved out first). Neither runs anything:
//     no tool, no job, no file but the canvas itself, saved through the normal revision-checked save, and the decision recorded.
//
// Imports nothing: canvas.js hands in the store's records, so these rules run in Node's tests too.

/** A draft's id, as the canvas server makes it (src/studio/server.ts). */
export const DRAFT_ID = /^draft-[0-9a-f]{8,32}$/;
/** The label on a pending draft, on the canvas and in the panel. */
export const DRAFT_LABEL = 'DRAFT · proposed by Timmy';
/** The records a draft may create: shapes, the bindings between them (or to the board's shapes), and the assets they show. */
export const DRAFT_CREATES = Object.freeze(['shape', 'binding', 'asset']);
/** The records that make up the document (the store's other records are this page's own view: camera, selection, pointer). */
export const DOCUMENT_TYPES = Object.freeze(['document', 'page', 'shape', 'binding', 'asset']);

const isRevision = (n) => Number.isInteger(n) && n >= 0;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The draft mark a record carries (meta.timmyDraft), or null. */
export function draftOf(record) {
  const d = record && record.meta && record.meta.timmyDraft;
  return d && typeof d === 'object' && typeof d.id === 'string' && DRAFT_ID.test(d.id) ? d : null;
}

/** The mark a draft call puts on what it creates. `from`: the canvas revision it was made from. */
export function draftMark({ id, job = null, from, at = new Date().toISOString() }) {
  if (!DRAFT_ID.test(String(id))) throw new Error(`Not a draft id: ${JSON.stringify(id).slice(0, 40)}`);
  return { id, job: typeof job === 'string' ? job : null, from: isRevision(from) ? from : null, at };
}

/**
 * The pending drafts among `records` (every record of the store), oldest first: each with its id, job, the revision it was made
 * from, when, its shapes (ids), the pages they are on, and its assets.
 */
export function pendingDrafts(records) {
  const byId = new Map();
  const shapes = new Map();
  for (const r of records) if (r && r.typeName === 'shape') shapes.set(r.id, r);
  const pageOf = (r) => {
    let at = r;
    for (let i = 0; at && i < 64; i++) {
      if (typeof at.parentId === 'string' && at.parentId.startsWith('page:')) return at.parentId;
      at = shapes.get(at.parentId);
    }
    return null;
  };
  for (const r of records) {
    const d = draftOf(r);
    if (!d || (r.typeName !== 'shape' && r.typeName !== 'asset')) continue;
    if (!byId.has(d.id)) byId.set(d.id, { id: d.id, job: d.job ?? null, from: isRevision(d.from) ? d.from : null, at: typeof d.at === 'string' ? d.at : null, shapes: [], pages: [], assets: [] });
    const draft = byId.get(d.id);
    if (r.typeName === 'asset') { draft.assets.push(r.id); continue; }
    draft.shapes.push(r.id);
    const page = pageOf(r);
    if (page && !draft.pages.includes(page)) draft.pages.push(page);
  }
  // A draft whose shapes are all gone (the person deleted them) is no longer pending: only its assets would be left.
  return [...byId.values()].filter((d) => d.shapes.length > 0).sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
}

/**
 * What a call did to the document, from its records before and after (each a map of id → record, as a store snapshot's
 * `store`): the ids it created, changed and removed, among the document's records only.
 */
export function documentChanges(before, after) {
  const isDoc = (r) => r && DOCUMENT_TYPES.includes(r.typeName);
  const created = [];
  const changed = [];
  const removed = [];
  for (const [id, r] of Object.entries(after)) {
    if (!isDoc(r)) continue;
    if (!(id in before)) created.push(id);
    else if (JSON.stringify(before[id]) !== JSON.stringify(r)) changed.push(id);
  }
  for (const [id, r] of Object.entries(before)) if (isDoc(r) && !(id in after)) removed.push(id);
  return { created, changed, removed };
}

/**
 * Why a draft call is refused after it ran, in words; null when it only added. It may create shapes, bindings and assets, and
 * change or remove only what was a pending draft before it ran (Timmy arranging its own proposal); anything else it touched (a
 * shape or binding of the board's own, a page, the document) is the person's, and a draft never changes it.
 */
export function draftRefusal(changes, before, after) {
  const typeOf = (id) => (after[id] || before[id] || {}).typeName || 'record';
  const pending = (id) => {
    const r = before[id];
    if (!r) return false;
    if (draftOf(r)) return true;
    // a binding from or to a pending draft's shape is that draft's too
    if (r.typeName === 'binding') return [r.fromId, r.toId].some((s) => draftOf(before[s]));
    return false;
  };
  const added = changes.created.filter((id) => !DRAFT_CREATES.includes(typeOf(id)));
  const touched = [...changes.changed.filter((id) => !followed(before[id], after[id])), ...changes.removed].filter((id) => !pending(id));
  if (added.length === 0 && touched.length === 0) return null;
  const parts = [];
  if (touched.length) parts.push(`it changed or removed ${plural(touched.length, 'record')} already on the board (${touched.slice(0, 3).join(', ')}${touched.length > 3 ? ', …' : ''})`);
  if (added.length) parts.push(`it added ${plural(added.length, typeOf(added[0]))}, which a draft does not`);
  return `Refused: a draft only adds to the board, and ${parts.join('; ')}. Nothing was kept. Propose new shapes as a draft; to change the board's own shapes, ask the person, or run the call without draft (it asks them first in Timmy).`;
}

/** Timmy's drawn cards (./cards.js CARD_SHAPES), and the props the page itself writes as a card follows its record. */
const DRAWN_CARDS = ['timmy-workflow', 'timmy-params', 'timmy-result'];
const FOLLOWED_PROPS = ['data', 'readAt', 'gone', 'title', 'command', 'h'];
/**
 * Whether a change is the page's own following of a drawn card's record (./cards.js onAnswer, which can run while a call
 * awaits): only those props changed, nothing else of the card. Such a change is never the call's, so it never refuses a draft.
 */
export function followed(a, b) {
  if (!a || !b || a.typeName !== 'shape' || !DRAWN_CARDS.includes(a.type) || a.type !== b.type) return false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k !== 'props' && JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  for (const k of new Set([...Object.keys(a.props || {}), ...Object.keys(b.props || {})])) {
    if (!FOLLOWED_PROPS.includes(k) && JSON.stringify(a.props[k]) !== JSON.stringify(b.props[k])) return false;
  }
  return true;
}

/** The words of a draft made from a revision the canvas has left; nothing of it ran. */
export function staleWords(from, now) {
  return `Refused: this draft was made from revision ${from}, but the canvas is at revision ${now} now: it changed after Timmy read it. Nothing was drawn. Read the canvas again (canvas_read), then propose again.`;
}

/**
 * The records that accept draft `id`, as they will be written: each record it marks (shapes and assets), its mark cleared and
 * the rest of its meta kept, with meta.timmyProposed saying who proposed it and when it was accepted (`at`).
 */
export function acceptPlan(records, id, at = new Date().toISOString()) {
  const out = [];
  for (const r of records) {
    const d = draftOf(r);
    if (!d || d.id !== id) continue;
    const { timmyDraft: _gone, ...meta } = r.meta;
    out.push({ ...r, meta: { ...meta, timmyProposed: { by: 'Timmy', draft: id, job: d.job ?? null, accepted: at } } });
  }
  return out;
}

/**
 * What discarding draft `id` removes: its shapes (a shape whose parent is in the draft goes with it), its assets that no shape
 * outside the draft shows; and the person's own shapes inside a draft shape, which are moved out to that draft shape's nearest
 * parent outside the draft first (`keepOut`: child id → new parent id), so nothing of theirs goes with it.
 */
export function discardPlan(records, id) {
  const shapes = new Map();
  for (const r of records) if (r && r.typeName === 'shape') shapes.set(r.id, r);
  const inDraft = (r) => { const d = draftOf(r); return !!d && d.id === id; };
  const drafted = new Set([...shapes.values()].filter(inDraft).map((r) => r.id));
  const outside = (sid) => {
    let at = shapes.get(sid);
    for (let i = 0; at && drafted.has(at.id) && i < 64; i++) at = shapes.get(at.parentId) ?? { id: at.parentId };
    return at ? at.id : null;
  };
  const keepOut = {};
  for (const r of shapes.values()) {
    if (drafted.has(r.id) || !drafted.has(r.parentId)) continue;
    const to = outside(r.parentId);
    if (to) keepOut[r.id] = to;
  }
  // only the top of each drafted subtree needs removing; its drafted children go with it
  const top = [...drafted].filter((sid) => !drafted.has(shapes.get(sid).parentId));
  const shown = new Set([...shapes.values()].filter((r) => !drafted.has(r.id) && r.props && typeof r.props.assetId === 'string').map((r) => r.props.assetId));
  const assets = records.filter((r) => r && r.typeName === 'asset' && inDraft(r) && !shown.has(r.id)).map((r) => r.id);
  return { shapes: top, all: [...drafted], keepOut, assets };
}

/** One line for a pending draft, in the panel: its label, size, job and the revision it was made from. */
export function draftLine(d) {
  const parts = [DRAFT_LABEL, plural(d.shapes.length, 'shape')];
  if (d.job) parts.push(`job ${d.job}`);
  if (isRevision(d.from)) parts.push(`from revision ${d.from}`);
  return parts.join(' · ');
}

/**
 * What the panel's band says once a decision is made: `d` the draft (its shapes, or their `count`, and its job); `saved` the save
 * that holds it ({ revision }), or null while it is not saved yet.
 */
export function decisionWords(decision, d, saved) {
  const count = Array.isArray(d.shapes) ? d.shapes.length : Number(d.count) || 0;
  const what = `${decision === 'accepted' ? 'Accepted' : 'Discarded'} Timmy's draft (${plural(count, 'shape')}${d.job ? `, job ${d.job}` : ''})`;
  const effect = decision === 'accepted' ? 'its shapes are the board\'s now' : 'its shapes are gone from the board';
  const tail = saved ? `saved at revision ${saved.revision} and recorded` : 'not saved yet: the save line above says why';
  return `${what}: ${effect}; ${tail}. Nothing ran: no tool, job or file but the canvas.`;
}
