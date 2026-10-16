// R6 (H145, step 4a): custom nodes. A palette in Studio's side panel (index.html #nodes) of the kinds of card the shown project
// already has, by the node each one makes:
//   a parameter, workflow or result node   one card of the project, as its drawn card (./cards.js place): it follows its record
//   an operation node                      an operation's cards at once, left to right in the order they ran, linked by arrows
//                                          bound to them (./cards.js placeOperation)
// Nothing new is invented: a node is the project's own card, bound to the project (its props name the project's id, and another
// project's board withholds it: src/studio/canvas-auth.ts DRAWN_CARD_TYPES).
//
// The palette lists the readings the Project panel already makes (./project.js, every few seconds), and only a reading of the
// board on screen (its ticket current, its project the one shown). Adding a node reads the project again (the card as it is
// now). It is refused while Studio switches boards, is paused or shows none; a reading that comes back after a switch places
// nothing on either board, and is noted under Kept apart.
//
// R6 (H145, step 4c): connections. An arrow bound at both ends to two of Timmy's cards connects them. Data flows along it only
// when it is one of an operation's own links (below: connectionOf); any other is a link that carries no data, and says so on the
// board and in the panel's Connections. Imports only ./operations.js (which imports nothing), so its rules run in Node too.

import { isTimmyArrow, OPERATION_ID, PLACEMENTS, placementKey, readPlacement } from './operations.js';

/** The node kinds, in the order the palette shows them: the drawn card's type (./cards.js CARD_SHAPES), or operation. */
export const NODE_KINDS = [
  { kind: 'params', title: 'Parameter nodes', one: 'parameter node' },
  { kind: 'workflow', title: 'Workflow nodes', one: 'workflow node' },
  { kind: 'result', title: 'Result nodes', one: 'result node' },
  { kind: 'operation', title: 'Operation nodes', one: 'operation node' },
];

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => { const c = Array.from(one(s)); return c.length > n ? `${c.slice(0, n - 1).join('')}…` : c.join(''); };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * The palette of a project reading (`now`: GET /api/project's answer): the project's cards that draw, grouped by the node each
 * makes (`drawnType`: ./cards.js drawnType, a card kind to its drawn card's type), and its operations with at least one card
 * that draws. Each item keeps its card's (or operation's) id, kind, title and state, as the reading says them.
 */
export function paletteOf(now, drawnType) {
  const cards = Array.isArray(now && now.cards) ? now.cards.filter((c) => c && typeof c.id === 'string') : [];
  const byId = new Map(cards.map((c) => [c.id, c]));
  const groups = Object.fromEntries(NODE_KINDS.map((k) => [k.kind, []]));
  for (const c of cards) {
    const t = drawnType(c.kind);
    if (t && groups[t] && t !== 'operation') groups[t].push({ id: c.id, kind: one(c.kind), title: cut(c.title, 160), state: cut(c.state, 240) });
  }
  for (const op of Array.isArray(now && now.operations) ? now.operations : []) {
    if (!op || !OPERATION_ID.test(String(op.id))) continue;
    const ids = Array.isArray(op.cards) ? op.cards.filter((x) => typeof x === 'string') : [];
    const draws = [...new Set(ids)].filter((id) => byId.has(id) && drawnType(byId.get(id).kind)).length;
    if (!draws) continue;
    groups.operation.push({ id: op.id, kind: 'operation', title: cut(op.request, 160) || `operation ${op.id}`, state: `${one(op.state) || 'state not recorded'} · ${plural(draws, 'card')} that draw` });
  }
  const project = now && now.project && typeof now.project.id === 'string' ? { id: now.project.id, name: one(now.project.name) || now.project.id } : null;
  return { project, groups: NODE_KINDS.map((k) => ({ ...k, items: groups[k.kind] })) };
}

/** How many nodes of each kind the palette offers, in words: "2 parameter · 2 workflow · 5 result · 1 operation". */
export const countWords = (palette) => palette.groups.map((g) => `${g.items.length} ${g.one.replace(' node', '')}`).join(' · ');

/** The words an add refused while Studio switches, is paused or shows no board says. */
export function notNowWords(scope) {
  if (scope && scope.state === 'switching') return `Not added: Studio is switching to ${scope.switching ? scope.switching.name : 'another project'}, so no node is added to either board until its board is loaded.`;
  if (scope && scope.state === 'paused') return `Not added: ${one(scope.paused) || 'the canvas shows a project this page cannot show.'}`;
  return 'Not added: no board is on screen yet.';
}

// ── connections (step 4c): arrows bound to cards; data flows only along an operation's own links ────────────────────────────
//
// The card model records one data path between cards: an operation's own sequence. An operation node ("Place this operation",
// ./cards.js placeOperation) places the operation's cards that draw, in the order they ran, each linked to the next by an arrow
// bound to both whose meta names the operation (./operations.js placementPlan, isTimmyArrow). A connection is one of those links,
// and data flows along it, only when both its cards were placed for the same operation and its end ran right after its start
// among that operation's cards that draw (the project reading's order). Any other arrow between two of Timmy's cards is a link
// that carries no data: the arrow says so on the board (LINK_LABEL), and the panel's Connections say why. Words a person wrote
// on an arrow are never replaced.

/** The meta key a link without data keeps: the cards it joins, their project, who drew it (by) and when it was labelled. */
export const LINK_META = 'timmyLink';
/** The words on an arrow that joins two cards without data. */
export const LINK_LABEL = 'link only · no data flows';
const CARD_TYPE = /^timmy-(workflow|params|result|artifact)$/;
const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/** The words of a tldraw rich text (its text nodes, in order). */
export function richWords(rich) {
  const out = [];
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 12) return;
    if (typeof n.text === 'string') out.push(n.text);
    if (Array.isArray(n.content)) { for (const c of n.content) walk(c, depth + 1); if (n.type === 'paragraph') out.push(' '); }
  };
  walk(rich, 0);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Each listed operation's cards that draw, in the order they ran (op id → card ids): the order an operation node links them in
 * (./operations.js placementPlan: the operation's cards the reading lists with a drawn card, each once).
 */
export function ordersOf(now, drawnType) {
  const cards = new Map((Array.isArray(now && now.cards) ? now.cards : []).filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
  const out = new Map();
  for (const o of Array.isArray(now && now.operations) ? now.operations : []) {
    if (!o || !OPERATION_ID.test(String(o.id)) || out.has(o.id)) continue;
    const order = [];
    for (const id of Array.isArray(o.cards) ? o.cards : []) {
      const c = typeof id === 'string' ? cards.get(id) : undefined;
      if (c && drawnType(c.kind) && !order.includes(id)) order.push(id);
    }
    out.set(o.id, order);
  }
  return Object.fromEntries(out);
}

/** The operation each card's own record names, as the reading says it (card id → op id). */
export function recordsOf(now) {
  const out = new Map();
  for (const c of Array.isArray(now && now.cards) ? now.cards : []) {
    if (c && typeof c.id === 'string' && OPERATION_ID.test(String(c.operation)) && !out.has(c.id)) out.set(c.id, c.operation);
  }
  return Object.fromEntries(out);
}

/** A card on the board as the connection rules read it (null: not one of Timmy's cards). */
export function nodeOf(shape) {
  if (!shape || shape.typeName !== 'shape' || !CARD_TYPE.test(String(shape.type))) return null;
  const p = shape.props || {};
  const op = shape.meta && OPERATION_ID.test(String(shape.meta.timmyOperation)) ? shape.meta.timmyOperation : null;
  return { id: shape.id, type: shape.type, card: String(p.card ?? ''), projectId: String(p.projectId ?? ''), project: one(p.project), op, title: cut(p.title || p.card, 80) };
}

/**
 * What a connection from node `a` to node `b` means (nodeOf both). `orders`: ordersOf the project's reading; `records`: recordsOf
 * it. Data flows only along an operation's own link: both cards placed for the same operation (their meta names it) and `b` the
 * card that ran right after `a` among its cards that draw. Anything else is a link without data, with why in words; a connection
 * across projects, or of a node to itself, is refused.
 */
export function connectionOf(a, b, orders = {}, records = {}) {
  if (!a || !b) return { refused: true, words: 'Not connected: each end is one of Timmy\'s cards on this board (a node, or an artifact card).' };
  if (a.id === b.id) return { refused: true, words: `Not connected: ${a.title} is not connected to itself.` };
  if (a.projectId !== b.projectId) return { refused: true, words: `Not connected: ${a.title} and ${b.title} are cards of different projects; a node is connected on its own project's board only.` };
  const link = (why) => ({ data: false, words: `Link only, no data flows: ${why}.` });
  if (a.card && a.card === b.card) return link(`both ends are drawn cards of one record (${a.title})`);
  const step = (op) => {
    const order = own(orders, op) && Array.isArray(orders[op]) ? orders[op] : [];
    return { i: order.indexOf(a.card), j: order.indexOf(b.card) };
  };
  if (a.op && a.op === b.op) {
    const { i, j } = step(a.op);
    if (i < 0 || j < 0) return link(`the project's records, as Timmy reads them now, do not list both ${a.title} and ${b.title} among operation ${a.op}'s cards`);
    if (j === i + 1) return { data: true, op: a.op, words: `Data flows: ${a.title} → ${b.title}, the next step of operation ${a.op} in the order its records give.` };
    if (j < i) return link(`${b.title} ran before ${a.title} in operation ${a.op}`);
    return link(`${a.title} and ${b.title} are not consecutive steps of operation ${a.op}`);
  }
  if (a.op && b.op) return link(`${a.title} and ${b.title} were placed for different operations (${a.op}, ${b.op})`);
  const ra = a.op || (own(records, a.card) ? records[a.card] : null);
  const rb = b.op || (own(records, b.card) ? records[b.card] : null);
  if (ra && ra === rb) {
    const { i, j } = step(ra);
    if (i >= 0 && j === i + 1) {
      const which = !a.op && !b.op ? 'neither card was' : `${(a.op ? b : a).title} was not`;
      return link(`${b.title} ran right after ${a.title} in operation ${ra}, but ${which} placed for it, and data flows only between the cards its operation node places`);
    }
  }
  return link(`Timmy's records name no data path from ${a.title} to ${b.title}; data flows only along an operation's own links`);
}

/** What an arrow's meta keeps (LINK_META) when it joins nodes `a` and `b` without data. `by`: 'connect' (drawn by Connect) or 'label' (drawn by hand, labelled by Studio). */
export const linkMeta = (a, b, by, at) => ({ v: 1, from: a.card, to: b.card, project: a.projectId, data: false, by, at });

/**
 * Whether Studio labels arrow `arrow` (a tldraw arrow record) now, as a link without data, given what it joins (`c`: its
 * connectionOf): no data flows along it, it has no words on it, it was never labelled (a label a person takes off is not put
 * back) and it is not a draft's (Accept or Discard decides what a draft holds).
 */
export function labelsNow(arrow, c) {
  if (!arrow || arrow.type !== 'arrow' || !c || c.refused || c.data !== false) return false;
  const meta = arrow.meta && typeof arrow.meta === 'object' ? arrow.meta : {};
  if (meta[LINK_META] || meta.timmyDraft) return false;
  return richWords(arrow.props && arrow.props.richText) === '';
}

/** Who drew an arrow, and what became of its words, from its own meta and words (`c`: its connectionOf). */
export function arrowBy(arrow, c) {
  const meta = arrow && arrow.meta && typeof arrow.meta === 'object' ? arrow.meta : {};
  if (meta.timmyDraft) return 'a draft\'s arrow: left as the draft drew it until you accept or discard it';
  if (isTimmyArrow(arrow)) return c && c.data === false ? `drawn for operation ${meta.timmyOperation}, now between other cards` : `drawn for operation ${meta.timmyOperation}`;
  const kept = meta[LINK_META] && typeof meta[LINK_META] === 'object' ? meta[LINK_META] : null;
  const words = richWords(arrow && arrow.props && arrow.props.richText);
  const who = kept && kept.by === 'connect' ? 'drawn by Connect' : typeof meta.timmyJob === 'string' && meta.timmyJob ? `drawn by job ${cut(meta.timmyJob, 40)}` : 'drawn by hand';
  if (!kept) return words ? `${who}; its own words kept` : who;
  if (words === LINK_LABEL) return kept.by === 'connect' ? who : `${who}; labelled by Studio`;
  return words ? `${who}; its words changed by hand` : `${who}; its label taken off by hand`;
}

/**
 * Where a new arrow between two cards meets them (tldraw's normalized anchor, the same on both cards), when `between` arrows join
 * the two already (the other way round): the first runs through their middles; each next one in a lane of its own beside it,
 * alternately below and above, so no arrow is drawn over another (a link without data over an operation's own link would read as
 * that link's label). `precise`: whether the anchor is kept (tldraw aims an arrow that is not precise at the card's middle).
 */
export function laneOf(between) {
  const n = Math.max(0, Math.floor(Number(between) || 0));
  if (n === 0) return { anchor: { x: 0.5, y: 0.5 }, precise: false };
  const y = 0.5 + (n % 2 ? 1 : -1) * 0.2 * Math.ceil(n / 2);
  return { anchor: { x: 0.5, y: Math.min(0.9, Math.max(0.1, Math.round(y * 100) / 100)) }, precise: true };
}

/** The words a connection refused while Studio switches, is paused or shows no board says. */
export const notNowConnectWords = (scope) => notNowWords(scope).replace(/^Not added: /, 'Not connected: ').replace('no node is added to', 'nothing is connected on');

/** The words a connection refused while a call of Timmy's draws on the board says. */
export const CALLING_WORDS = 'Not connected: a call of Timmy\'s is drawing on this board now (what it draws is its own until it ends); connect the two nodes once it ends.';

// ── the palette (the browser only) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * deps: scope() (the board on screen: { project, state, switching, paused }), current(ticket), read() (the project reading as it
 * is now, with the ticket of the board it was asked for), kept(project, detail) (a reading of another board, noted),
 * drawnType(kind), placeCard(id, reading), placeOperation(opId, reading), say(words, failed). Step 4c: editor(), createShapeId(),
 * toRichText(text), calling() (whether a call of Timmy's runs on the page now: nothing is labelled then).
 */
export function createNodes(deps) {
  let shown = null;
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, attrs = {}) => {
    const e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'className') e.className = v; else e.setAttribute(k, String(v)); }
    return e;
  };

  /** A reading the Project panel made: drawn only when it is of the board on screen. */
  function onReading(now) {
    if (!now || now.refused || now.pinned || !now.project || !deps.current(now.ticket)) return;
    const sc = deps.scope();
    if (sc.state !== 'shown' || !sc.project || sc.project.id !== now.project.id) return;
    const palette = paletteOf(now, deps.drawnType);
    // step 4c: each operation's cards that draw in the order they ran, and the operation each card's record names
    const orders = ordersOf(now, deps.drawnType);
    const records = recordsOf(now);
    const sig = JSON.stringify([palette, orders, records]);
    if (shown && shown.sig === sig) return;
    shown = { sig, palette, orders, records };
    draw();
    boardChanged();
  }

  /** Studio switched boards (or paused, or loaded one): the palette of the board before is put away at once. */
  function scopeChanged() {
    shown = null;
    draw();
    drawLinks();
  }

  function draw() {
    const name = $('nodes-name');
    const note = $('nodes-note');
    const host = $('node-palette');
    if (!name || !note || !host) return;
    const sc = deps.scope();
    host.replaceChildren();
    if (!shown || sc.state !== 'shown' || !sc.project || !shown.palette.project || shown.palette.project.id !== sc.project.id) {
      name.textContent = sc.state === 'switching' ? 'switching…' : 'reading…';
      note.textContent = sc.state === 'shown' ? `Reading ${sc.project ? `${sc.project.name}'s` : 'the project\'s'} cards…` : notNowWords(sc).replace(/^Not added: /, '');
      host.dataset.project = '';
      return;
    }
    const p = shown.palette;
    name.textContent = `${p.project.name} · ${countWords(p)}`;
    note.textContent = `Each node is one of ${p.project.name}'s own cards, added to ${p.project.name}'s board and bound to ${p.project.name}: a parameter, workflow or result node is its drawn card, which follows its record; an operation node is the operation's cards, linked in the order they ran.`;
    host.dataset.project = p.project.id;
    for (const g of p.groups) {
      const section = el('section', null, { className: 'ngroup', 'data-node-group': g.kind });
      section.append(el('h3', `${g.title} (${g.items.length})`, { className: 'ngroup-title' }));
      if (!g.items.length) {
        section.append(el('p', `None in ${p.project.name} now.`, { className: 'nitem-none' }));
      } else {
        const list = el('ul', null, { className: 'nitems', 'aria-label': `${g.title} of ${p.project.name}` });
        for (const it of g.items) {
          const li = el('li', null, { className: 'nitem', 'data-node-kind': g.kind, 'data-node-id': it.id, 'data-project': p.project.id });
          li.append(el('span', it.title, { className: 'nitem-title' }));
          if (g.kind === 'result') li.append(el('span', it.kind, { className: 'nitem-kind' }));
          li.append(el('span', it.state, { className: 'nitem-state' }));
          const add = el('button', 'Add node', { type: 'button', className: 'nitem-add', title: `Adds this ${g.one} to ${p.project.name}'s board, bound to ${p.project.name}` });
          add.addEventListener('click', () => {
            add.disabled = true;
            nodeAdd(g.kind, it.id).then((r) => deps.say(r.words), (e) => deps.say(e instanceof Error ? e.message : String(e), true)).finally(() => { add.disabled = false; });
          });
          li.append(add);
          list.append(li);
        }
        section.append(list);
      }
      host.append(section);
    }
  }

  /**
   * Adds node `id` of kind `kind` to the board on screen, from the project as it is now: what it placed, and its words. Refused,
   * in words, while Studio switches, is paused or shows no board, and when the board changed while the project was read.
   */
  async function nodeAdd(kind, id) {
    const sc = deps.scope();
    if (sc.state !== 'shown' || !sc.project) throw new Error(notNowWords(sc));
    const k = NODE_KINDS.find((x) => x.kind === kind);
    if (!k) throw new Error(`Not added: ${cut(kind, 40)} is not a kind of node (parameter, workflow, result or operation).`);
    const now = await deps.read();
    if (!now || !deps.current(now.ticket) || (now.project && now.project.id !== sc.project.id)) {
      if (now && now.project) deps.kept(now.project, 'its cards');
      throw new Error(`Not added: Studio switched boards while it read ${sc.project.name}'s cards, so nothing was placed on either board.`);
    }
    if (!now.project) throw new Error(`Not added: ${one(now.message) || 'Timmy did not let this page read the project.'}`);
    onReading(now);
    if (deps.scope().state !== 'shown') throw new Error(notNowWords(deps.scope()));
    if (kind === 'operation') {
      if (!(now.operations || []).some((o) => o && o.id === id)) throw new Error(`Not added: no operation ${cut(id, 40)} in ${now.project.name} now.`);
      const r = await deps.placeOperation(String(id), now);
      return { kind, id: String(id), project: now.project.id, select: r.select ?? [], words: r.words };
    }
    const card = (now.cards || []).find((c) => c && c.id === id);
    if (!card || deps.drawnType(card.kind) !== kind) throw new Error(`Not added: no ${k.one} ${cut(id, 80)} in ${now.project.name} now.`);
    const r = await deps.placeCard(String(id), now);
    return { kind, id: String(id), project: now.project.id, shape: r.shape, words: `Added a ${k.one} to ${now.project.name}'s board: ${cut(card.title, 120)}.` };
  }

  // ── step 4c: connections ──
  let retry = null;
  /** boardChanged again in a moment: a gesture, or a call of Timmy's, is under way now. */
  function later(ms) {
    if (retry) return;
    retry = setTimeout(() => { retry = null; try { boardChanged(); } catch { /* the next change of the board draws them */ } }, ms);
  }

  /** The cards an arrow is bound to: its start's and its end's shape ids (null where an end is free). */
  function endsOf(editor, arrow) {
    const b = editor.getBindingsFromShape(arrow.id, 'arrow');
    return { start: b.find((x) => x.props.terminal === 'start')?.toId ?? null, end: b.find((x) => x.props.terminal === 'end')?.toId ?? null };
  }

  /** The arrows on the board on screen bound at both ends to Timmy's cards of the project shown, each with what it means. */
  function linksOn(editor) {
    const sc = deps.scope();
    if (!editor || sc.state !== 'shown' || !sc.project) return [];
    const out = [];
    for (const s of editor.getCurrentPageShapes()) {
      if (s.type !== 'arrow') continue;
      const e = endsOf(editor, s);
      const a = e.start ? nodeOf(editor.getShape(e.start)) : null;
      const b = e.end ? nodeOf(editor.getShape(e.end)) : null;
      if (!a || !b || a.projectId !== sc.project.id || b.projectId !== sc.project.id) continue;
      let c;
      if (a.id === b.id) c = { data: false, words: `Link only, no data flows: an arrow from ${a.title} back to itself.` };
      else if (!shown) c = { data: null, words: `Reading ${sc.project.name}'s records: whether data flows along this arrow is said once they are read.` };
      else c = connectionOf(a, b, shown.orders, shown.records);
      out.push({ shape: s, from: a, to: b, c });
    }
    return out;
  }

  /**
   * The connections on the board on screen, as the panel lists them: each arrow bound at both ends to Timmy's cards of the project
   * shown, from its start to its end, whether data flows along it (null until the project's records are read), why, and who drew it.
   * The data links come first, by operation, in the order its cards ran; then the others, as they lie on the board.
   */
  function connections(editor = deps.editor && deps.editor()) {
    const step = (x) => (x.c.data === true && shown && own(shown.orders, x.c.op) ? shown.orders[x.c.op].indexOf(x.from.card) : -1);
    const ranked = linksOn(editor).map((x, i) => ({ x, i })).sort((p, q) => {
      const dp = p.x.c.data === true ? 0 : 1;
      const dq = q.x.c.data === true ? 0 : 1;
      if (dp !== dq) return dp - dq;
      if (dp === 0 && p.x.c.op !== q.x.c.op) return p.x.c.op < q.x.c.op ? -1 : 1;
      return (dp === 0 ? step(p.x) - step(q.x) : 0) || p.i - q.i;
    }).map((r) => r.x);
    return ranked.map(({ shape, from, to, c }) => ({
      arrow: shape.id, from, to, data: c.data === true ? true : c.data === false ? false : null, op: c.data === true ? c.op : null,
      words: c.words, label: richWords(shape.props && shape.props.richText), by: arrowBy(shape, c),
    }));
  }

  /**
   * The page's record of operation `op`'s placements (./operations.js PLACEMENTS) names `arrow` as its link from card `from` to card
   * `to`, so a later press of the operation node counts that link as drawn, never as one a person deleted. Only where the page keeps
   * a record of the operation.
   */
  function relink(editor, projectId, op, from, to, arrow) {
    const page = editor.getCurrentPage();
    const held = page.meta && page.meta[PLACEMENTS] && typeof page.meta[PLACEMENTS] === 'object' && !Array.isArray(page.meta[PLACEMENTS]) ? page.meta[PLACEMENTS] : null;
    const key = placementKey(projectId, op);
    if (!held || !own(held, key)) return;
    const rec = held[key] && typeof held[key] === 'object' && !Array.isArray(held[key]) ? held[key] : {};
    const links = [...readPlacement(rec).links.filter((l) => !(l.from === from && l.to === to)), { from, to, arrow }];
    editor.updatePage({ id: page.id, meta: { ...page.meta, [PLACEMENTS]: { ...held, [key]: { ...rec, links } } } });
  }

  /**
   * Connects node `fromId` to node `toId` (their shape ids) on the board on screen with an arrow bound to both, from the project's
   * records as they are now (read first, as adding a node reads them): an operation's own link when data flows between them (an
   * arrow whose meta names the operation, as an operation node draws one, solid), else a link labelled LINK_LABEL (dashed) whose
   * meta keeps what it joins. One step of tldraw's undo. Refused, in words, while Studio switches, is paused or shows no board,
   * while a call of Timmy's draws on it, when the board changed while the records were read, and for cards of another project.
   */
  async function connect(fromId, toId) {
    const sc = deps.scope();
    if (sc.state !== 'shown' || !sc.project) throw new Error(notNowConnectWords(sc));
    const editor = deps.editor && deps.editor();
    if (!editor) throw new Error('Not connected: no board is on screen yet.');
    if (deps.calling && deps.calling()) throw new Error(CALLING_WORDS);
    const pick = (id) => nodeOf(editor.getShape(String(id)));
    if (!pick(fromId) || !pick(toId)) throw new Error('Not connected: each end is one of Timmy\'s cards on this board (a node, or an artifact card).');
    const now = await deps.read();
    if (!now || !deps.current(now.ticket) || (now.project && now.project.id !== sc.project.id) || deps.editor() !== editor) {
      if (now && now.project) deps.kept(now.project, 'its records');
      throw new Error(`Not connected: Studio switched boards while it read ${sc.project.name}'s records, so nothing was connected on either board.`);
    }
    if (!now.project) throw new Error(`Not connected: ${one(now.message) || 'Timmy did not let this page read the project.'}`);
    onReading(now);
    const after = deps.scope();
    if (after.state !== 'shown' || !after.project || after.project.id !== sc.project.id) throw new Error(notNowConnectWords(after));
    if (deps.calling && deps.calling()) throw new Error(CALLING_WORDS);
    const a = pick(fromId);
    const b = pick(toId);
    if (!a || !b) throw new Error('Not connected: one of the two cards left this board while Studio read the records.');
    if (a.projectId !== sc.project.id || b.projectId !== sc.project.id) throw new Error(`Not connected: a node is connected on its own project's board only, and this board is ${sc.project.name}'s.`);
    const c = connectionOf(a, b, shown ? shown.orders : {}, shown ? shown.records : {});
    if (c.refused) throw new Error(c.words);
    const already = linksOn(editor).find((x) => x.from.id === a.id && x.to.id === b.id);
    if (already) return { arrow: already.shape.id, data: already.c.data === true, op: already.c.data === true ? already.c.op : null, already: true, words: `Already connected: ${already.c.words}` };
    const ba = editor.getShapePageBounds(a.id);
    const bb = editor.getShapePageBounds(b.id);
    if (!ba || !bb) throw new Error('Not connected: one of the two cards is not on this page.');
    // the arrows that join the two already (the other way round): this one runs in a lane of its own beside them
    const lane = laneOf(linksOn(editor).filter((x) => x.from.id === b.id && x.to.id === a.id).length);
    const start = { x: ba.maxX, y: ba.minY + ba.height * lane.anchor.y };
    const end = { x: bb.minX, y: bb.minY + bb.height * lane.anchor.y };
    const id = deps.createShapeId();
    const at = new Date().toISOString();
    editor.markHistoryStoppingPoint(`timmy connect ${a.card} to ${b.card}`);
    editor.run(() => {
      editor.createShape({
        id, type: 'arrow', x: start.x, y: start.y,
        meta: c.data ? { timmyOperation: c.op } : { [LINK_META]: linkMeta(a, b, 'connect', at) },
        props: { kind: 'elbow', start: { x: 0, y: 0 }, end: { x: end.x - start.x, y: end.y - start.y }, dash: c.data ? 'solid' : 'dashed', size: 's', ...(c.data ? {} : { richText: deps.toRichText(LINK_LABEL) }) },
      });
      editor.createBindings([
        { type: 'arrow', fromId: id, toId: a.id, props: { terminal: 'start', normalizedAnchor: lane.anchor, isPrecise: lane.precise, isExact: false } },
        { type: 'arrow', fromId: id, toId: b.id, props: { terminal: 'end', normalizedAnchor: lane.anchor, isPrecise: lane.precise, isExact: false } },
      ]);
      if (c.data) relink(editor, a.projectId, c.op, a.card, b.card, id);
    });
    drawLinks(editor);
    return { arrow: id, data: c.data === true, op: c.data ? c.op : null, words: `Connected ${a.title} → ${b.title}. ${c.words}` };
  }

  /**
   * The board changed (or the project's records were read): an arrow drawn between two of Timmy's cards of the project shown, along
   * which no data flows, with no words on it, is labelled LINK_LABEL once (labelsNow; its meta keeps what it joins, outside tldraw's
   * undo, as Timmy's other follow-up writes are). Not before the records are read, not while a call of Timmy's draws on the board
   * (a call only adds: ./drafts.js), and not mid-gesture or while words are typed: then once those end. The panel's Connections
   * are drawn again.
   */
  function boardChanged(editor = deps.editor && deps.editor()) {
    const want = shown ? linksOn(editor).filter((x) => labelsNow(x.shape, x.c)) : [];
    if (want.length) {
      const inputs = editor.inputs || {};
      const busy = (deps.calling && deps.calling()) || !!(inputs.getIsPointing && inputs.getIsPointing()) || !!(inputs.getIsDragging && inputs.getIsDragging()) || !!editor.getEditingShapeId();
      if (busy) later(400);
      else {
        const at = new Date().toISOString();
        editor.run(() => editor.updateShapes(want.map((x) => ({ id: x.shape.id, type: 'arrow', props: { richText: deps.toRichText(LINK_LABEL) }, meta: { ...(x.shape.meta || {}), [LINK_META]: linkMeta(x.from, x.to, 'label', at) } }))), { history: 'ignore' });
      }
    }
    drawLinks(editor);
  }

  /** The panel's Connections: the rule, the Connect button (two of the shown project's nodes selected) and each connection. */
  let linksSig = '';
  function drawLinks(editor = deps.editor && deps.editor()) {
    wireConnect();
    const rule = $('node-links-note');
    const note = $('node-connect-note');
    const btn = $('node-connect');
    const list = $('node-link-list');
    if (!rule || !note || !btn || !list) return;
    const sc = deps.scope();
    if (!rule.textContent) rule.textContent = `Data flows only along an operation's own links: from a card its operation node placed to the card that ran next. Any other arrow between two nodes is a link only, and says so on the board ("${LINK_LABEL}"); words you write on an arrow are kept.`;
    const on = !!editor && sc.state === 'shown' && !!sc.project;
    const sel = on ? editor.getSelectedShapeIds().map((id) => nodeOf(editor.getShape(id))).filter((n) => n && n.projectId === sc.project.id) : [];
    const pair = sel.length === 2 ? sel : null;
    btn.disabled = !pair;
    btn.dataset.from = pair ? pair[0].id : '';
    btn.dataset.to = pair ? pair[1].id : '';
    const preview = pair && shown ? connectionOf(pair[0], pair[1], shown.orders, shown.records) : null;
    note.textContent = !on
      ? notNowConnectWords(sc)
      : !pair
        ? `Select two nodes on ${sc.project.name}'s board (shift-click the second): Connect draws an arrow from the first you select to the second.`
        : `From ${pair[0].title} to ${pair[1].title}: ${preview ? preview.words : `Studio reads ${sc.project.name}'s records first.`}`;
    const now = connections(editor);
    const sig = JSON.stringify([on, now.map((c) => [c.arrow, c.data, c.words, c.by, c.from.title, c.to.title])]);
    if (sig === linksSig && list.childElementCount) return;
    linksSig = sig;
    list.replaceChildren(...(now.length ? now.map((c) => {
      const flow = c.data === true ? 'data' : c.data === false ? 'link' : 'unread';
      const li = el('li', null, { className: `nlink is-${flow}`, 'data-arrow': c.arrow, 'data-flow': flow, 'data-from': c.from.id, 'data-to': c.to.id });
      li.append(
        el('span', flow === 'data' ? `data · operation ${c.op}` : flow === 'link' ? 'link only' : 'reading…', { className: 'nlink-kind' }),
        el('span', `${c.from.title} → ${c.to.title}`, { className: 'nlink-ends' }),
        el('span', c.words, { className: 'nlink-words' }),
        el('span', c.by, { className: 'nlink-by' }),
      );
      return li;
    }) : [el('li', on ? 'No connections on this board yet: select two nodes and press Connect, or draw an arrow from one card to another.' : 'No board on screen.', { className: 'nlink-none' })]));
  }

  /** The Connect button: the first selected node to the second. */
  function wireConnect() {
    const btn = $('node-connect');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const from = btn.dataset.from;
      const to = btn.dataset.to;
      if (!from || !to) return;
      btn.disabled = true;
      connect(from, to).then((r) => deps.say(r.words), (e) => deps.say(e instanceof Error ? e.message : String(e), true)).finally(() => drawLinks());
    });
  }

  return { onReading, scopeChanged, draw, add: nodeAdd, connect, connections, boardChanged, drawLinks, get palette() { return shown ? shown.palette : null; } };
}
