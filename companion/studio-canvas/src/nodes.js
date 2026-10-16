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
// nothing on either board, and is noted under Kept apart. Imports nothing, so its rules run in Node too.

/** The node kinds, in the order the palette shows them: the drawn card's type (./cards.js CARD_SHAPES), or operation. */
export const NODE_KINDS = [
  { kind: 'params', title: 'Parameter nodes', one: 'parameter node' },
  { kind: 'workflow', title: 'Workflow nodes', one: 'workflow node' },
  { kind: 'result', title: 'Result nodes', one: 'result node' },
  { kind: 'operation', title: 'Operation nodes', one: 'operation node' },
];
const OPERATION_ID = /^o[0-9a-f]{8}$/;

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

// ── the palette (the browser only) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * deps: scope() (the board on screen: { project, state, switching, paused }), current(ticket), read() (the project reading as it
 * is now, with the ticket of the board it was asked for), kept(project, detail) (a reading of another board, noted),
 * drawnType(kind), placeCard(id, reading), placeOperation(opId, reading), say(words, failed).
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
    const sig = JSON.stringify(palette);
    if (shown && shown.sig === sig) return;
    shown = { sig, palette };
    draw();
  }

  /** Studio switched boards (or paused, or loaded one): the palette of the board before is put away at once. */
  function scopeChanged() {
    shown = null;
    draw();
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

  return { onReading, scopeChanged, draw, add: nodeAdd, get palette() { return shown ? shown.palette : null; } };
}
