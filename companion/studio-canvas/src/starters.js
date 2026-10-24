// R11 round 7 (H176): the guided blank public starters (TEMPLATE SCHEMA v1: src/studio/templates/H*.json, listed by
// src/studio/templates.ts) as tldraw 5.5.2 records, and where a drawn card lands on one (its slots). A starter is the structure
// of a recovered Houdini board (the handoff's lanes and manifest, the cookbook's categories, the atlas's typed-port pipeline)
// with every card blank and a guidance card per step, drawn into THIS project's board on a page of its own; every shape keeps
// the recovered loader's meta (workbench, page, role, lane, data) beside Timmy's (timmyTemplate, timmyGuide, timmyStarter), and
// an arrow between two cards is a tldraw arrow bound at both ends, so it follows them.
//
// What runs: nothing on a starter. A step frame with a slot ('result', 'params', 'workflow') is the one place where the matching
// drawn card lands when it is added from the panel's Nodes (./cards.js place asks emptySlot below): the card is the project's
// own, follows its record, and its Save, Rebuild or Run go to the REPL that holds the project exactly as on any board. A snippet
// card is text; a Houdini snippet's presence is never drawn as an operation (its words say so).
//
// Imports nothing: the rules run in Node's tests (tests/studio-starters.test.ts validates the records against the installed
// tldraw's own schema, and the typed ports and their order).

/** The shape meta version a starter writes (bumped on a breaking change of the meta). */
export const STARTER_WORKBENCH = 'timmy-starter-v1';
/** A step's slot and the drawn card that lands in it (./cards.js CARD_SHAPES). */
export const SLOT_SHAPES = Object.freeze({ params: 'timmy-params', workflow: 'timmy-workflow', result: 'timmy-result' });
/** Where a slotted card sits in its frame (page units): under the frame's hint, with room at the edges. */
export const SLOT_INSET = Object.freeze({ x: 20, y: 96, right: 20, bottom: 20 });
/** A step frame, as the guided blank boards draw theirs (canvas.js openGuided). */
export const STEP = Object.freeze({ w: 340, h: 250, gap: 56 });
/** tldraw's colour names (5.5.2); a starter's own colours are among them (templates.ts refuses any other). */
export const COLORS = Object.freeze(['black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow', 'orange', 'green', 'light-green', 'light-red', 'red', 'white']);

/** tldraw's rich text for lines of text (an empty line is an empty paragraph), as tldraw's toRichText makes it. */
export function richTextOf(lines) {
  const list = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  return { type: 'doc', content: list.map((line) => (line === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text: String(line) }] })) };
}

/**
 * tldraw 5.5.2's default props for the shapes a starter draws (what the editor fills for a prop left out: here every prop is
 * written, so the records validate in Node as they do in the page). tests/studio-starters.test.ts holds them to the installed
 * validators: a key tldraw adds or drops fails there, not on a board.
 */
export function defaultProps(type, o = {}) {
  const w = Number(o.w) > 0 ? Number(o.w) : 8;
  const h = Number(o.h) > 0 ? Number(o.h) : 8;
  if (type === 'geo') return { geo: 'rectangle', dash: 'draw', url: '', w, h, growY: 0, scale: 1, flipX: false, flipY: false, labelColor: 'black', color: 'black', fill: 'none', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', richText: richTextOf(['']) };
  if (type === 'text') return { color: 'black', size: 'm', font: 'draw', textAlign: 'start', w, richText: richTextOf(['']), scale: 1, autoSize: true };
  if (type === 'frame') return { w, h, name: '', color: 'black' };
  if (type === 'arrow') return { kind: 'arc', labelColor: 'black', color: 'black', fill: 'none', dash: 'draw', size: 'm', arrowheadStart: 'none', arrowheadEnd: 'arrow', font: 'draw', start: { x: 0, y: 0 }, end: { x: 2, y: 0 }, bend: 0, richText: richTextOf(['']), labelPosition: 0.5, scale: 1, elbowMidPoint: 0.5 };
  throw new Error(`no default props for a ${type} shape`);
}

const STYLE_KEYS = ['color', 'fill', 'dash', 'size', 'font', 'geo', 'align', 'verticalAlign'];

/** A node's ports (data.ports, a JSON string of [{ id, direction, dataType }]), or []; a port that is not one is left out. */
export function portsOf(shape) {
  const raw = shape && shape.data && typeof shape.data === 'object' ? shape.data.ports : undefined;
  if (typeof raw !== 'string') return [];
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && (p.direction === 'in' || p.direction === 'out') && typeof p.dataType === 'string')
    .map((p) => ({ id: p.id, direction: p.direction, dataType: p.dataType }));
}

/**
 * The bindings of starter `t` checked against its shapes: each joins two shapes that are not arrows; a typed one (fromPort,
 * toPort, dataType) names an 'out' port of its start and an 'in' port of its end, both of its data type; and the whole is
 * acyclic. Returns the problems in words (none: the starter is sound) and the order (Kahn over the bindings, ties in the shapes'
 * own order): key → position, for every shape a binding touches.
 */
export function checkBindings(t) {
  const problems = [];
  const shapes = Array.isArray(t && t.shapes) ? t.shapes : [];
  const bindings = Array.isArray(t && t.bindings) ? t.bindings : [];
  const byKey = new Map(shapes.filter((s) => s && typeof s.key === 'string').map((s) => [s.key, s]));
  const keys = new Set();
  for (const b of bindings) {
    if (!b || typeof b.key !== 'string') { problems.push('a binding has no key'); continue; }
    if (keys.has(b.key)) problems.push(`binding ${b.key} is named twice`);
    keys.add(b.key);
    const from = byKey.get(b.from);
    const to = byKey.get(b.to);
    if (!from || from.type === 'arrow') problems.push(`binding ${b.key} starts at ${JSON.stringify(b.from)}, which is not a card of this starter`);
    if (!to || to.type === 'arrow') problems.push(`binding ${b.key} ends at ${JSON.stringify(b.to)}, which is not a card of this starter`);
    if (from && to && from === to) problems.push(`binding ${b.key} joins ${b.from} to itself`);
    const typed = b.fromPort !== undefined || b.toPort !== undefined || b.dataType !== undefined;
    if (typed) {
      if (typeof b.fromPort !== 'string' || typeof b.toPort !== 'string' || typeof b.dataType !== 'string') { problems.push(`binding ${b.key} is typed in part only (fromPort, toPort and dataType go together)`); continue; }
      const out = from ? portsOf(from).find((p) => p.id === b.fromPort && p.direction === 'out') : null;
      const inn = to ? portsOf(to).find((p) => p.id === b.toPort && p.direction === 'in') : null;
      if (from && !out) problems.push(`binding ${b.key}: ${b.from} has no out port ${b.fromPort}`);
      if (to && !inn) problems.push(`binding ${b.key}: ${b.to} has no in port ${b.toPort}`);
      if (out && out.dataType !== b.dataType) problems.push(`binding ${b.key} carries ${b.dataType}, but ${b.from}.${b.fromPort} gives ${out.dataType}`);
      if (inn && inn.dataType !== b.dataType) problems.push(`binding ${b.key} carries ${b.dataType}, but ${b.to}.${b.toPort} takes ${inn.dataType}`);
    }
  }
  // Kahn: the nodes the bindings touch, in the shapes' order; an edge per sound binding
  const nodes = shapes.map((s) => s && s.key).filter((k) => typeof k === 'string' && bindings.some((b) => b && (b.from === k || b.to === k)));
  const edges = bindings.filter((b) => b && byKey.has(b.from) && byKey.has(b.to) && b.from !== b.to);
  const indegree = new Map(nodes.map((k) => [k, 0]));
  for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const order = new Map();
  let ready = nodes.filter((k) => indegree.get(k) === 0);
  while (ready.length) {
    const k = ready.shift();
    order.set(k, order.size);
    for (const e of edges.filter((x) => x.from === k)) {
      indegree.set(e.to, indegree.get(e.to) - 1);
      if (indegree.get(e.to) === 0) ready = nodes.filter((n) => ready.includes(n) || n === e.to);
    }
  }
  if (order.size < nodes.length) problems.push(`the bindings form a cycle (${nodes.filter((k) => !order.has(k)).join(', ')})`);
  return { problems, order };
}

/** The words of a node in an order line: its data.nodeId, else its key. */
const nodeWord = (s) => (s && s.data && typeof s.data === 'object' && typeof s.data.nodeId === 'string' && s.data.nodeId ? s.data.nodeId : s.key);

/**
 * Starter `t` as tldraw records for one opening: `ids.shapeId()` gives each shape a fresh id (two openings on one board never
 * collide; the file's key is kept in meta.timmyStarter.key). Returns { shapes, bindings }: the shapes in drawing order (the
 * title, the intro, the three step frames with their hints and the flow between them, then the starter's own cards, then the
 * arrows of its bindings), each { id, type, x, y, parentId?, props (every prop of tldraw 5.5.2's validator), meta }; the
 * bindings as editor.createBindings takes them (an arrow's start and end, precise, bound to the cards). Throws when the
 * starter's bindings are not sound (checkBindings): nothing of it is drawn.
 */
export function starterRecords(t, ids) {
  const checked = checkBindings(t);
  if (checked.problems.length) throw new Error(`Starter ${t && t.id ? t.id : '?'} is not drawn: ${checked.problems.join('; ')}.`);
  const shapes = [];
  const bindings = [];
  const idOf = new Map();
  const meta = (role, lane, data, extra = {}) => ({ workbench: STARTER_WORKBENCH, page: String(t.page || 'houdini'), role, lane, data: data && typeof data === 'object' ? { ...data } : {}, timmyTemplate: t.id, timmyGuide: role, timmyStarter: { key: extra.key ?? role, from: String(t.from && t.from.template ? t.from.template : ''), ...(extra.slot ? { slot: extra.slot } : {}) } });
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const across = Math.max(1, steps.length);
  const width = across * STEP.w + (across - 1) * STEP.gap;
  // the title and what the board is for, as the guided blank boards draw them
  shapes.push({ id: ids.shapeId(), type: 'text', x: 0, y: -210, props: { ...defaultProps('text'), richText: richTextOf([String(t.title)]), size: 'l', font: 'sans', autoSize: true }, meta: meta('title', 'steps', {}, { key: 'title' }) });
  shapes.push({ id: ids.shapeId(), type: 'text', x: 0, y: -140, props: { ...defaultProps('text', { w: Math.min(width, 900) }), richText: richTextOf([String(t.intro)]), size: 's', font: 'sans', color: 'grey', autoSize: false }, meta: meta('intro', 'steps', {}, { key: 'intro' }) });
  // the three steps: a frame each (its name the step), a hint inside, the flow between them bound at both ends
  const frames = steps.map((step, i) => {
    const key = `step-${step.n}`;
    const id = ids.shapeId();
    idOf.set(key, { id, x: i * (STEP.w + STEP.gap), y: 0, w: STEP.w, h: STEP.h });
    shapes.push({ id, type: 'frame', x: i * (STEP.w + STEP.gap), y: 0, props: { ...defaultProps('frame', { w: STEP.w, h: STEP.h }), name: `${step.n} · ${step.verb}` }, meta: meta('step', 'steps', { n: step.n, verb: step.verb, slot: step.slot }, { key, slot: step.slot }) });
    shapes.push({ id: ids.shapeId(), type: 'text', x: 16, y: 16, parentId: id, props: { ...defaultProps('text', { w: STEP.w - 32 }), richText: richTextOf([String(step.guide)]), size: 's', font: 'sans', color: 'grey', autoSize: false }, meta: meta('hint', 'steps', { n: step.n }, { key: `hint-${step.n}` }) });
    return { key, id };
  });
  for (let i = 0; i + 1 < frames.length; i += 1) arrow(frames[i].key, frames[i + 1].key, 'flow', 'steps', { bindingId: `steps-${i + 1}`, fromNode: frames[i].key, toNode: frames[i + 1].key }, '');
  // the starter's own cards, in the file's order (a card inside a frame keeps the frame's own coordinates)
  for (const s of Array.isArray(t.shapes) ? t.shapes : []) {
    const id = ids.shapeId();
    const parent = s.parent ? idOf.get(s.parent) : null;
    idOf.set(s.key, { id, x: s.x + (parent ? parent.x : 0), y: s.y + (parent ? parent.y : 0), w: s.w, h: s.h });
    const data = { ...(s.data && typeof s.data === 'object' ? s.data : {}) };
    if (checked.order.has(s.key)) data.dagPosition = checked.order.get(s.key);
    let lines = Array.isArray(s.text) ? s.text.map(String) : [];
    if (s.role === 'dag-order') {
      const ordered = [...checked.order.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => nodeWord((t.shapes || []).find((x) => x && x.key === k) || { key: k }));
      data.order = ordered.join(' → ');
      data.bindingCount = (t.bindings || []).length;
      lines = [...lines, data.order];
    }
    const props = { ...defaultProps(s.type, s) };
    for (const k of STYLE_KEYS) if (s[k] !== undefined && k in props) props[k] = s[k];
    if (s.type === 'frame') props.name = lines[0] ?? '';
    else props.richText = richTextOf(lines.length ? lines : ['']);
    if (s.type === 'text') { props.autoSize = false; props.w = s.w; }
    const record = { id, type: s.type, x: s.x, y: s.y, props, meta: meta(String(s.role), String(s.lane), data, { key: s.key, slot: s.slot }) };
    if (parent) record.parentId = parent.id;
    shapes.push(record);
  }
  // the bindings' arrows: from the start card's right middle to the end card's left middle, bound to both
  for (const b of Array.isArray(t.bindings) ? t.bindings : []) {
    const typed = typeof b.dataType === 'string';
    const data = typed
      ? { bindingId: b.key, fromNode: b.from, fromPort: b.fromPort, toNode: b.to, toPort: b.toPort, dataType: b.dataType, binding: JSON.stringify({ id: b.key, fromNode: b.from, fromPort: b.fromPort, toNode: b.to, toPort: b.toPort, dataType: b.dataType }) }
      : { bindingId: b.key, fromNode: b.from, toNode: b.to };
    const lane = (t.shapes || []).find((x) => x && x.key === b.from)?.lane ?? 'steps';
    arrow(b.from, b.to, typed ? 'port-binding' : 'flow', String(lane), data, typed ? b.dataType : '');
  }
  return { shapes, bindings };

  function arrow(fromKey, toKey, role, lane, data, label) {
    const a = idOf.get(fromKey);
    const b = idOf.get(toKey);
    if (!a || !b) return;
    const start = { x: a.x + a.w, y: a.y + a.h / 2 };
    const end = { x: b.x, y: b.y + b.h / 2 };
    const id = ids.shapeId();
    shapes.push({
      id, type: 'arrow', x: start.x, y: start.y,
      props: { ...defaultProps('arrow'), color: 'grey', dash: 'solid', size: 's', font: 'mono', start: { x: 0, y: 0 }, end: { x: end.x - start.x, y: end.y - start.y }, richText: richTextOf([label]) },
      meta: meta(role, lane, data, { key: data.bindingId }),
    });
    bindings.push({ type: 'arrow', fromId: id, toId: a.id, props: { terminal: 'start', normalizedAnchor: { x: 1, y: 0.5 }, isExact: false, isPrecise: true, snap: 'none' } });
    bindings.push({ type: 'arrow', fromId: id, toId: b.id, props: { terminal: 'end', normalizedAnchor: { x: 0, y: 0.5 }, isExact: false, isPrecise: true, snap: 'none' } });
  }
}

// ── slots: where a drawn card lands on a starter (the browser, and Node's tests on plain records) ─────────────────────────────

/** Whether a shape is a starter's step frame with a slot: its meta.timmyStarter.slot names a drawn card (SLOT_SHAPES). */
export const slotOf = (shape) => {
  const s = shape && shape.type === 'frame' && shape.meta && typeof shape.meta === 'object' && shape.meta.timmyStarter && typeof shape.meta.timmyStarter === 'object' ? shape.meta.timmyStarter.slot : undefined;
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(SLOT_SHAPES, s) ? s : null;
};
const DRAWN = new Set(Object.values(SLOT_SHAPES));

/**
 * The first empty slot frame on a page that takes a drawn card of `cardType` (a timmy-params card lands in a 'params' slot, and so
 * on): among `shapes` (the page's), the frames whose slot names that card type and that hold no drawn card yet, the topmost
 * (then leftmost) first; null when there is none. A full slot is left alone: the card goes where the free-spot rule puts it.
 */
export function emptySlot(shapes, cardType) {
  const list = Array.isArray(shapes) ? shapes : [];
  const slots = list.filter((s) => { const slot = slotOf(s); return slot && SLOT_SHAPES[slot] === cardType; })
    .filter((f) => !list.some((c) => c && c.parentId === f.id && DRAWN.has(c.type)))
    .sort((p, q) => (p.y - q.y) || (p.x - q.x));
  return slots[0] ?? null;
}

/** Where a card sits inside its slot frame (the frame's own coordinates): under the hint, SLOT_INSET in. */
export const slotPosition = () => ({ x: SLOT_INSET.x, y: SLOT_INSET.y });

/**
 * The size slot frame `frame` needs to show its children whole (`children`: the shapes parented to it, each with x, y and
 * props.w / props.h in the frame's own coordinates): never smaller than it is. Null when it fits already.
 */
export function slotFit(frame, children) {
  const list = Array.isArray(children) ? children.filter((c) => c && c.parentId === frame.id) : [];
  let w = Number(frame.props && frame.props.w) || 0;
  let h = Number(frame.props && frame.props.h) || 0;
  for (const c of list) {
    const cw = Number(c.props && c.props.w) || 0;
    const ch = Number(c.props && c.props.h) || 0;
    w = Math.max(w, Math.ceil(c.x + cw + SLOT_INSET.right));
    h = Math.max(h, Math.ceil(c.y + ch + SLOT_INSET.bottom));
  }
  return w === (Number(frame.props && frame.props.w) || 0) && h === (Number(frame.props && frame.props.h) || 0) ? null : { w, h };
}

/** The words the panel adds when a node landed in a slot: the step it sits in. */
export const slottedWords = (frame) => `It sits in the starter's step ${String(frame && frame.props && frame.props.name ? frame.props.name : 'frame')}.`;
