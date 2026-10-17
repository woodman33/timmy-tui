// Round R4 (H55): the Project panel of Timmy Canvas. The REPL names its active project to the canvas server, and the
// server answers GET /api/project with the project's cards (src/studio/project-cards.ts), built from the board's own
// readers. This panel lists them; "Place on canvas" makes one tldraw note through the page's own editor, holding the
// card's title, state and command, with the record and receipt behind it in the note's meta; "Refresh placed cards"
// reads each placed card again from its record (its state changed: new text; its record gone: the note says so).
// "Open on the board" is a link to /board live's address while it runs: the board's token never reaches this page, the
// canvas or its saved document. Every text is set as text (textContent), never as markup.
//
// Round R4 (H75): "Place card" makes the card's drawn card (./cards.js: a workflow, parameter or result card that follows its
// record and, where Timmy allows, acts through the REPL). With `detail` the panel reads the project with each card's drawn
// detail and hands every reading to the drawn cards (`onAnswer`); it reads again sooner while `fast()` says a card's job runs.
//
// R4 (H100): every card names the operation its record names (read from the record at each reading: src/studio/project-
// cards.ts), on its row and on a placed note; the panel groups the cards by kind or by operation (By kind / By operation, kept
// for this browser), and an operation's group has "Place this operation" (./cards.js placeOperation), which places its
// workflow, flow and result cards at once, left to right in the order they ran, linked.
//
// Nothing here imports anything but ./operations.js (pure rules): canvas.js hands in tldraw's helpers, so this file's pure
// part runs in Node's tests too.
import { groupByOperation, OPERATION_ID, operationLine } from './operations.js';

/** The kinds of card, in the order the panel shows them (the editable artifacts first), with the heading of each. */
export const GROUPS = [
  ['workflow', 'Workflows'],
  ['params', 'Parameters'],
  ['flow', 'Flows'],
  ['vox', 'VoxVision'],
  ['run', 'Control Room'],
  ['unreadable', 'Unreadable records'],
];

const BOARD = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/$/;
const SECTIONS = new Set(['room', 'workflows', 'parameters', 'flows', 'voxvision']);
const META_KEY = 'timmyProjectCard';
/** R7 (H151): a project card's note as it is placed in mind: tldraw's note, 200 wide, a little taller as its words grow it. */
const NOTE_W = 200;
const NOTE_PLACE_H = 240;
/** R4 (H100): where this browser keeps the panel's grouping (By kind or By operation). */
const MODE_KEY = 'timmy-canvas-group-by';

/** R4 (H100): a card's operation, as the reading names it (null: its record names none). */
const opOf = (card) => (typeof card.operation === 'string' && OPERATION_ID.test(card.operation) ? card.operation : null);

/** The text a placed card holds: its title, its state and its command, one line each; R4 (H100): then its operation. */
export function cardText(card) {
  return [card.title, card.state, card.command, operationLine(opOf(card), card.operationFrom)].map((s) => String(s ?? '').replace(/\s+/g, ' ').trim()).join('\n');
}

/** What a placed card keeps in its meta: the card, the project it is from, the record and receipt behind it. Never a board address or token. */
export function cardMeta(card, project, now = new Date()) {
  return {
    v: 1,
    card: String(card.id),
    kind: String(card.kind),
    project: String(project.name),
    projectId: String(project.id),
    title: String(card.title),
    state: String(card.state),
    command: String(card.command),
    record: card.record == null ? null : String(card.record),
    receipt: card.receipt == null ? null : String(card.receipt),
    section: SECTIONS.has(card.section) ? card.section : null,
    ...(Array.isArray(card.highlights) && card.highlights.length ? { highlights: card.highlights.map(String).slice(0, 12) } : {}),
    // R4 (H100): the operation its record named at this reading, and where that was read (or why none)
    operation: opOf(card),
    operationFrom: String(card.operationFrom ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    placedAt: now.toISOString(),
  };
}

/** A placed card's meta, or null when the shape is not one of these cards. */
export function placedMeta(shape) {
  const m = shape && shape.meta ? shape.meta[META_KEY] : undefined;
  return m && typeof m === 'object' && typeof m.card === 'string' && typeof m.projectId === 'string' ? m : null;
}

// ── R4 (H109): following the active project, and boards pinned to one ─────────────────────────────────────────────────
// The operator's direction (2026-10-11): "Following windows change project together; pinned windows keep their visibly identified
// project." A board (a page of the canvas) follows the project the canvas shows (the active project: src/studio/active-follow.ts)
// unless a person pins it to a project: the pin is kept in the board's own meta (PIN), so it is part of the document (saved with
// it, undone with tldraw's undo, seen by every window that shows the board), and the panel reads that project for it
// (GET /api/project?project=<id>, read only). A project change never re-targets a board: its cards keep their own project.

/** Where a board keeps the project it is pinned to: its page's meta, under this key. */
export const PIN = 'timmyPin';

/** A board's pin, as its page's meta holds it, checked field by field; null when it is not pinned. */
export function readPin(meta) {
  const p = meta && typeof meta === 'object' ? meta[PIN] : undefined;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (typeof p.projectId !== 'string' || !/^[0-9a-f]{16}$/.test(p.projectId)) return null;
  const project = typeof p.project === 'string' && p.project.trim() ? p.project.replace(/\s+/g, ' ').trim().slice(0, 120) : p.projectId;
  return { projectId: p.projectId, project, at: typeof p.at === 'string' ? p.at : null };
}

/** A board's pin to the project a reading shows (what Pin keeps in the board's meta). */
export const pinFor = (project, now = new Date()) => ({ projectId: String(project.id), project: String(project.name), at: now.toISOString() });

/**
 * The line under the panel's heading: whether this board follows the project the canvas shows (the active project) or is pinned,
 * and, when they differ, the project the canvas shows and the active project of this Timmy home. `now`: the reading; `pin`: the
 * board's pin (readPin), or null.
 *
 * R6 (H139): each project has its own board now (src/studio/boards.ts), and Studio shows the board of the project the canvas
 * shows: when the active project changes, the whole board changes with it (its drafts, jobs and cards). A board pinned to a project
 * (a pin kept from the canvas a Timmy home had before, when every project's boards were in one) still reads that project's cards.
 */
export function followWords(now, pin) {
  const o = now || {};
  if (pin) {
    const shown = o.shown && o.shown.id !== pin.projectId ? ` The canvas shows ${o.shown.name} now.` : '';
    return `Pinned to ${pin.project}: this board reads ${pin.project}'s cards, whichever project's board holds it.${shown}`;
  }
  const active = o.active && o.project && o.active.id !== o.project.id
    ? ` The active project of this Timmy home is ${o.active.name}; the canvas shows ${o.project.name}, as Timmy's REPL named it.`
    : '';
  const own = o.project ? `${o.project.name}'s own board: Studio shows the board of the project the canvas shows, and switches to another project's own board when the active project changes.` : 'This board follows the project the canvas shows (the active project).';
  return `${o.project ? 'This is ' : ''}${own}${active}`;
}

/**
 * What the band says when the project a following board shows changes (null when it did not): the new project, and that the
 * board's cards of the one before stay as they were.
 */
export function changeWords(before, now) {
  if (!before || !now || !now.project || now.pinned || before.id === now.project.id) return null;
  const how = now.via === 'active' ? ', the active project of this Timmy home' : '';
  return `The canvas now shows ${now.project.name}${how} (it showed ${before.name}). Cards of ${before.name} on this board stay, shown as last read; nothing on the board was changed.`;
}

/** The live board's section of a card, as a link: only the board's bare address (http://127.0.0.1:<port>/) is linked. */
export function boardHref(board, card) {
  if (!board || typeof board.address !== 'string' || !BOARD.test(board.address)) return null;
  return SECTIONS.has(card.section) ? `${board.address}#${card.section}` : board.address;
}

/**
 * What a refresh does to one placed card, given the project API's answer now:
 *   same      nothing changed (nothing is written, so the canvas's revision stays)
 *   update    its state, title, command, record or receipt changed: new text and meta
 *   gone      its record is not among the project's cards any more: the note says so (once)
 *   other     the canvas now follows another project: left as it is, and said
 *   none      no project is named to the canvas: left as it is, and said
 */
export function refreshPlan(meta, api, now = new Date()) {
  if (!api || !api.project) return { action: 'none' };
  if (api.project.id !== meta.projectId) return { action: 'other', project: meta.project, now: api.project.name };
  const card = (api.cards || []).find((c) => c.id === meta.card);
  if (!card) {
    if (meta.gone) return { action: 'same' };
    const what = meta.record ? `its record ${meta.record}` : `card ${meta.card}`;
    // R4 (H100): the operation it named when last read, said as such
    const op = typeof meta.operation === 'string' && OPERATION_ID.test(meta.operation) ? `operation ${meta.operation}, as last read` : null;
    const text = [meta.title, `record gone: ${what} is not in ${api.project.name} now (checked ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC)`, meta.command, ...(op ? [op] : [])].join('\n');
    return { action: 'gone', text, meta: { ...meta, gone: true, goneAt: now.toISOString() } };
  }
  const fresh = cardMeta(card, api.project, now);
  // R4 (H100): a note placed before its operation was shown (no `operation` kept) is written again once, with it
  const same = !meta.gone && ['title', 'state', 'command', 'record', 'receipt', 'operation'].every((k) => fresh[k] === meta[k]);
  if (same) return { action: 'same' };
  const { gone: _gone, goneAt: _goneAt, ...kept } = meta;
  return { action: 'update', text: cardText(card), meta: { ...kept, ...fresh, placedAt: meta.placedAt, refreshedAt: now.toISOString() } };
}

/** A refresh's outcome in words. */
export function refreshWords(counts) {
  const n = counts.same + counts.update + counts.gone + counts.other + counts.none;
  if (n === 0) return 'No project cards are placed on this canvas yet.';
  const parts = [
    counts.update ? `${counts.update} changed` : '',
    counts.gone ? `${counts.gone} ${counts.gone === 1 ? 'record' : 'records'} gone` : '',
    counts.same ? `${counts.same} unchanged` : '',
    counts.other ? `${counts.other} from another project, left as they are` : '',
    counts.none ? `${counts.none} not checked: no project is named to this canvas` : '',
  ].filter(Boolean);
  return `${n} placed ${n === 1 ? 'card' : 'cards'} checked: ${parts.join(', ')}.`;
}

// ── the panel (the browser only) ─────────────────────────────────────────────

const el = (tag, text, props = {}) => Object.assign(document.createElement(tag), text === undefined ? {} : { textContent: text }, props);

/**
 * R4 (H109): the band between the list and New board (index.html #project-said, R4 H100): what a press did, or what Timmy did
 * on its own (the arrows it removed with a deleted card). `acts`: buttons under the words that act on what they say ({ label,
 * title, run }), such as selecting the cards a press placed. Each call replaces the words and the buttons before it.
 */
export function band(text, bad = false, acts = []) {
  if (typeof document === 'undefined') return;
  const said = document.getElementById('project-said');
  const row = document.getElementById('project-said-acts');
  if (said) {
    said.textContent = String(text ?? '');
    said.dataset.kind = bad ? 'error' : 'ok';
  }
  if (!row) return;
  row.replaceChildren(...(Array.isArray(acts) ? acts : []).map((a) => {
    const b = el('button', String(a.label), { type: 'button', className: 'band-act', title: String(a.title ?? '') });
    b.addEventListener('click', () => { try { a.run(); } catch { /* the band's buttons are a courtesy */ } });
    return b;
  }));
  row.hidden = row.childElementCount === 0;
}
/** A message's text, cut at `max` characters (an ellipsis says so): the panel stays short. */
const short = (text, max = 90) => { const chars = Array.from(String(text)); return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join(''); };

/**
 * The panel, attached to its elements in index.html. `deps`: editor() (the live editor), toRichText, createShapeId,
 * place(editor) → where a new card goes ({ x, y }, page coordinates), reveal(editor, ids). R4 (H75), each optional: detail
 * (read the drawn cards' detail too), onAnswer(now) (every reading), fast() (read again in 1.5 s, not 5 s), drawable(kind)
 * and placeCard(id, now) (Place card). R4 (H81): read() (the reading to use instead of this panel's own: the drawn cards'
 * reader, which reads the detail only with this page's session). R4 (H100): placeOperation(opId, now) (Place this operation).
 * R4 (H109): read(pinned) reads the project a board is pinned to (its id) when given one; runDetail(opId, projectId), optional,
 * shows an operation's run detail in the side panel (an operation's group offers Run detail).
 */
export function createProjectPanel(deps) {
  const root = document.getElementById('project');
  const name = document.getElementById('project-name');
  const note = document.getElementById('project-note');
  const groups = document.getElementById('project-groups');
  const refresh = document.getElementById('project-refresh');
  // R4 (H100): By kind / By operation, kept for this browser (a viewer's convenience: nothing else depends on it)
  const by = document.getElementById('project-by');
  // R4 (H109): whether this board follows the active project or is pinned, and the button that pins it or lets it follow again
  const follow = document.getElementById('project-follow');
  const pinButton = document.getElementById('project-pin');
  const pinBadge = document.getElementById('project-pinned');
  let mode = readMode();
  let api = null;
  let shown = '';
  /** R4 (H109): the board and pin the last reading was for, and the project a following board showed last */
  let readFor = '';
  let lastShown = null;
  /**
   * R6 (H139): `deps.accept(now)`, optional: whether a reading belongs to the board on screen (canvas.js: asked since the last switch,
   * of its project); one that does not is never drawn, placed from or handed to the drawn cards. `deps.hold()`, optional: the words
   * the panel shows instead of a project while Studio switches boards (null when it does not), when it reads nothing.
   */
  const fits = (now) => !deps.accept || deps.accept(now) === true;
  const NOT_NOW = 'Not now: Studio is switching to another project\'s board, so nothing of this reading is placed.';

  /** R4 (H109): the current board, and the project it is pinned to (null: it follows the project the canvas shows). */
  function boardNow() {
    const editor = deps.editor();
    const page = editor ? editor.getCurrentPage() : null;
    return { id: page ? page.id : '', pin: page ? readPin(page.meta) : null };
  }

  async function read() {
    // R4 (H109): what the reading is for: this board, pinned or following
    const b = boardNow();
    readFor = `${b.id}|${b.pin ? b.pin.projectId : ''}`;
    // R4 (H81): the drawn cards' own reader when given (./cards.js read: the cards' detail only through this page's session)
    if (deps.read) return deps.read(b.pin ? b.pin.projectId : null);
    const response = await fetch(deps.detail ? '/api/project?detail=1' : '/api/project', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Timmy answered ${response.status} for the project`);
    return response.json();
  }

  /** R4 (H109): pins the current board to the project it shows now, or lets a pinned board follow again; then reads at once. */
  function togglePin() {
    const editor = deps.editor();
    if (!editor) return;
    const page = editor.getCurrentPage();
    const pin = readPin(page.meta);
    const meta = { ...(page.meta || {}) };
    if (pin) {
      delete meta[PIN];
      editor.markHistoryStoppingPoint('timmy follow the active project');
      editor.updatePage({ id: page.id, meta });
      band(`This board follows the project the canvas shows again (it was pinned to ${pin.project}).`);
    } else {
      if (!api || !api.project) { band('There is no project to pin this board to: none is shown.', true); return; }
      meta[PIN] = pinFor(api.project);
      editor.markHistoryStoppingPoint('timmy pin this board');
      editor.updatePage({ id: page.id, meta });
      band(`This board is pinned to ${api.project.name}: it keeps it when the active project changes.`);
    }
    void poll();
  }
  if (pinButton) pinButton.addEventListener('click', togglePin);

  /** R4 (H109): the canvas showed another board (or its pin changed): read again at once, for it. */
  function boardChanged() {
    const b = boardNow();
    if (`${b.id}|${b.pin ? b.pin.projectId : ''}` !== readFor) void poll();
  }

  /** Places card `id` from the project as it is now; returns what was placed. */
  async function place(id, editor = deps.editor()) {
    const now = await read();
    if (!fits(now)) throw new Error(NOT_NOW);
    if (!now.project) throw new Error(now.message || 'No project is named to this canvas.');
    const card = (now.cards || []).find((c) => c.id === id);
    if (!card) throw new Error(`No card ${JSON.stringify(String(id)).slice(0, 120)} in ${now.project.name} now. Its cards: ${(now.cards || []).map((c) => c.id).join(', ').slice(0, 2000) || 'none'}.`);
    // R7 (H151; H147's R6 finding 5): where the note overlaps no shape on the page (canvas.js placeAt, ./placement.js); it had gone
    // to the middle of the area beside the panel, a step lower each time, over whatever was there. A note grows with its words:
    // once it has, it is moved clear if it grew over a shape.
    const at = deps.place(editor, { w: NOTE_W, h: NOTE_PLACE_H });
    const shapeId = deps.createShapeId();
    editor.createShape({
      id: shapeId, type: 'note', x: at.x, y: at.y,
      props: { richText: deps.toRichText(cardText(card)), size: 's', font: 'mono', align: 'start', verticalAlign: 'start' },
      meta: { [META_KEY]: cardMeta(card, now.project) },
    });
    editor.select(shapeId);
    try { deps.reveal(editor, [shapeId]); } catch { /* showing it is a courtesy */ }
    if (deps.keepClear) await deps.keepClear(editor, [shapeId]);
    show(now);
    return { placed: true, shape: shapeId, card: { id: card.id, title: card.title, state: card.state, command: card.command, record: card.record, receipt: card.receipt, operation: opOf(card) }, project: now.project.name };
  }

  /** Reads every placed card again from the project's records (all pages); counts what happened. */
  async function refreshAll(editor = deps.editor()) {
    const now = await read();
    if (!fits(now)) throw new Error(NOT_NOW);
    const counts = { same: 0, update: 0, gone: 0, other: 0, none: 0 };
    const placed = editor.store.allRecords().filter((r) => r.typeName === 'shape' && placedMeta(r));
    const updates = [];
    for (const shape of placed) {
      const plan = refreshPlan(placedMeta(shape), now);
      counts[plan.action] += 1;
      if (plan.action === 'update' || plan.action === 'gone') {
        updates.push({ id: shape.id, type: shape.type, props: { richText: deps.toRichText(plan.text) }, meta: { ...shape.meta, [META_KEY]: plan.meta } });
      }
    }
    if (updates.length) editor.updateShapes(updates);
    show(now);
    return { ...counts, words: refreshWords(counts) };
  }

  // R4 (H100; r24): what a press said has its own band between the list and New board (index.html #project-said): it never
  // sits on a row or its buttons, and an empty one takes no room. R4 (H109): written through band(), which cards.js uses too.
  function say(text, bad = false, acts = []) {
    band(text, bad, acts);
  }
  /** R4 (H109): selects the shapes a press placed that are still on the canvas (the band's Select button). */
  function selectPlaced(ids) {
    const editor = deps.editor();
    const there = editor ? ids.filter((id) => editor.getShape(id)) : [];
    if (there.length) editor.select(...there);
  }

  /** R4 (H100): a row; `withOp`: with its operation line (an operation's own group names the operation once, above its rows). */
  function row(card, board, withOp = true) {
    const li = el('li', undefined, { className: 'pcard' });
    li.dataset.card = card.id;
    li.append(el('div', card.title, { className: 'pcard-title' }), el('div', card.state, { className: 'pcard-state' }));
    const behind = [card.record ? `record ${card.record}` : '', card.receipt ? `receipt ${card.receipt}` : ''].filter(Boolean).join(' · ');
    if (behind) li.append(el('div', behind, { className: 'pcard-behind' }));
    if (withOp) li.append(el('div', operationLine(opOf(card), card.operationFrom), { className: opOf(card) ? 'pcard-op' : 'pcard-op pcard-op-none' }));
    const cmd = el('button', undefined, { type: 'button', className: 'pcard-cmd', title: 'Copy this command, then paste it into Timmy' });
    cmd.append(el('code', card.command));
    cmd.addEventListener('click', () => {
      const copied = () => say(`Copied: ${card.command}`);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(card.command).then(copied, () => say('The browser did not allow copying; select the command by hand.', true));
    });
    const acts = el('div', undefined, { className: 'pcard-acts' });
    const put = el('button', 'Place on canvas', { type: 'button', className: 'pcard-place' });
    put.addEventListener('click', () => {
      put.disabled = true;
      place(card.id).then((r) => say(`Placed: ${short(r.card.title)}`), (e) => say(`Not placed: ${short(e instanceof Error ? e.message : String(e), 300)}`, true)).finally(() => { put.disabled = false; });
    });
    acts.append(put);
    // R4 (H75): its drawn card, which follows its record and says whether it is a diagram or executable.
    if (deps.placeCard && deps.drawable && deps.drawable(card.kind)) {
      const drawn = el('button', 'Place card', { type: 'button', className: 'pcard-drawn', title: 'A drawn card that follows its record; its buttons act through Timmy\'s REPL when Timmy allows it, and it says so' });
      drawn.addEventListener('click', () => {
        drawn.disabled = true;
        placeCard(card.id).then((r) => say(`Placed card: ${short(r.card.title)}`), (e) => say(`Not placed: ${short(e instanceof Error ? e.message : String(e), 300)}`, true)).finally(() => { drawn.disabled = false; });
      });
      acts.append(drawn);
    }
    const href = boardHref(board, card);
    // R4 (H60): the new tab asks a board tab already open for the token (the board's own handoff); this page never holds it.
    if (href) acts.append(el('a', 'Open on the board', { className: 'pcard-board', href, target: '_blank', rel: 'noopener noreferrer', title: 'The live board on this machine (/board live); a tab of it you already have open gives the new tab its token' }));
    li.append(cmd, acts);
    return li;
  }

  /** R4 (H75): places card `id`'s drawn card from the project as it is now. */
  async function placeCard(id) {
    const now = await read();
    if (!fits(now)) throw new Error(NOT_NOW);
    show(now);
    return deps.placeCard(id, now);
  }

  /** R4 (H100): places operation `id`'s cards from the project as it is now (./cards.js placeOperation); what it did, in words. */
  async function placeOperation(id) {
    if (!deps.placeOperation) throw new Error('This page cannot place an operation\'s cards.');
    const now = await read();
    if (!fits(now)) throw new Error(NOT_NOW);
    show(now);
    return deps.placeOperation(String(id), now);
  }

  /** R4 (H100): an operation's group: its id and state, its request, Place this operation, and its cards in the order they ran. */
  function opSection(group, board) {
    const { op, cards } = group;
    const section = el('section', undefined, { className: 'pgroup pop' });
    section.dataset.op = op.id;
    const head = el('h3', undefined, { className: 'pop-head' });
    head.append(el('span', `Operation ${op.id}`, { className: 'pop-id' }), ' · ', el('span', String(op.state ?? ''), { className: 'pop-state' }));
    section.append(head, el('p', op.request ? op.request : 'No record of its request in this project.', { className: op.request ? 'pop-request' : 'pop-request pop-none', title: op.request ? `Its request, as its record says: ${op.request}` : '' }));
    if (op.note) section.append(el('p', String(op.note), { className: 'pop-note' }));
    const acts = el('div', undefined, { className: 'pop-acts' });
    const draws = cards.filter((c) => deps.drawable && deps.drawable(c.kind)).length;
    if (deps.placeOperation && draws > 0) {
      const put = el('button', 'Place this operation', { type: 'button', className: 'pop-place', title: 'Places its workflow, flow and result cards on this page, left to right in the order they ran, linked by arrows. Pressed again, it adds only what ran since: cards you moved, resized or deleted stay as you left them.' });
      put.addEventListener('click', () => {
        put.disabled = true;
        // R4 (H109): nothing it placed is selected; the band offers to select it
        const offer = (r) => (Array.isArray(r.select) && r.select.length
          ? [{ label: `Select the ${r.select.length === 1 ? 'card' : `${r.select.length} cards`} placed`, title: 'Selects only what this press placed, so one drag moves them together', run: () => selectPlaced(r.select) }]
          : []);
        placeOperation(op.id).then((r) => say(r.words, false, offer(r)), (e) => say(`Not placed: ${short(e instanceof Error ? e.message : String(e), 300)}`, true)).finally(() => { put.disabled = false; });
      });
      acts.append(put);
    }
    // R4 (H109): its run detail (made by Timmy), in the side panel; of the project this board reads (pinned, or the one shown)
    if (deps.runDetail && OPERATION_ID.test(String(op.id))) {
      const rd = el('button', 'Run detail', { type: 'button', className: 'pop-rd', title: `Shows the run detail of operation ${op.id} in this panel: its verdict, stage, exits, freshness, acceptance, files, receipts and cost, each with the record it came from` });
      rd.addEventListener('click', () => { void deps.runDetail(String(op.id), api && api.project ? api.project.id : null); });
      acts.append(rd);
    }
    acts.append(el('span', `${cards.length} ${cards.length === 1 ? 'card' : 'cards'}, in the order they ran`, { className: 'pop-count' }));
    section.append(acts, Object.assign(el('ol'), { className: 'plist' }));
    section.lastChild.append(...cards.map((c) => row(c, board, false)));
    return section;
  }

  /** The groups by kind (as before), or (R4 H100) by operation, then the cards whose records name none. */
  function sections(now) {
    if (mode === 'operation') {
      const { groups: ops, rest } = groupByOperation(now, GROUPS.map(([kind]) => kind));
      const parts = ops.map((g) => opSection(g, now.board));
      if (rest.length) {
        const section = el('section', undefined, { className: 'pgroup pop-rest' });
        section.dataset.op = '';
        section.append(el('h3', `No operation named (${rest.length})`), el('p', 'Their records name no operation: each says why.', { className: 'pop-request pop-none' }), Object.assign(el('ol'), { className: 'plist' }));
        section.lastChild.append(...rest.map((c) => row(c, now.board)));
        parts.push(section);
      }
      return parts;
    }
    return GROUPS.map(([kind, heading]) => {
      const cards = (now.cards || []).filter((c) => c.kind === kind);
      if (!cards.length) return null;
      const section = el('section', undefined, { className: 'pgroup' });
      section.dataset.kind = kind;
      section.append(el('h3', `${heading} (${cards.length})`), Object.assign(el('ol'), { className: 'plist' }));
      section.lastChild.append(...cards.map((c) => row(c, now.board)));
      return section;
    }).filter(Boolean);
  }

  /** Draws the panel from an API answer; only when it changed, keeping the focus on the button it was on. */
  function show(now) {
    // R6 (H139): a reading of another board than the one on screen is never drawn (nor handed to the drawn cards)
    if (!fits(now)) return;
    api = now;
    // R4 (H75): every reading reaches the drawn cards, changed or not (they say when they were read).
    try { deps.onAnswer?.(now); } catch { /* a card that cannot follow says so itself */ }
    // R4 (H109): this board follows the active project, or is pinned to one (visibly); a following board whose project changed
    // says so in the band (its cards of the project before stay as they were)
    const pin = boardNow().pin;
    if (follow) { follow.textContent = followWords(now, pin); follow.hidden = false; follow.dataset.kind = pin ? 'pinned' : 'follows'; }
    if (pinBadge) { pinBadge.hidden = !pin; pinBadge.textContent = pin ? 'pinned' : ''; }
    if (pinButton) {
      // R6 (H139): a board is its project's own now, so there is nothing to pin it to; a pin kept from before can be let go
      pinButton.hidden = !pin;
      pinButton.textContent = pin ? 'Follow the active project' : now.project ? `Pin this board to ${short(now.project.name, 40)}` : 'Pin this board';
      pinButton.title = pin ? `This board is pinned to ${pin.project}; let it follow the project the canvas shows again` : 'Keep this board on this project when the active project changes (kept in the board, so every window shows it pinned)';
    }
    if (!pin && now.project) {
      const words = changeWords(lastShown, now);
      if (words) band(words);
      lastShown = { id: now.project.id, name: now.project.name };
    }
    const sig = JSON.stringify([mode, now.project, now.board, now.cards, now.operations, now.notes, now.message, now.pinned, now.shown, now.active]);
    if (sig === shown) return;
    shown = sig;
    const active = document.activeElement && groups.contains(document.activeElement) ? document.activeElement : null;
    const focused = active ? { card: active.closest('li')?.dataset.card, op: active.closest('section.pop')?.dataset.op, cls: active.className } : null;
    // R4 (H83): a reading refused to this page (its session does not count now) names no project: it says why below
    // R4 (H109): a pinned board names its project even when its reading was refused (the line under it says why)
    name.textContent = now.project ? now.project.name : pin ? pin.project : now.refused ? 'not shown' : 'none named';
    const notes = [now.message, ...(now.notes || [])].filter(Boolean);
    note.textContent = notes.join(' ');
    note.hidden = notes.length === 0;
    refresh.hidden = !now.project;
    if (by) by.hidden = !now.project;
    const parts = sections(now);
    groups.replaceChildren(...(parts.length ? parts : now.project ? [el('p', 'No cards yet: workflows, parameter files, flows, VoxVision records and runs show here.', { className: 'pcard-empty' })] : []));
    const first = focused ? `.${String(focused.cls).split(' ')[0]}` : '';
    if (focused && focused.card) {
      const back = [...groups.querySelectorAll('li.pcard')].find((li) => li.dataset.card === focused.card)?.querySelector(first);
      if (back) back.focus();
    } else if (focused && focused.op) {
      const back = [...groups.querySelectorAll('section.pop')].find((s) => s.dataset.op === focused.op)?.querySelector(first);
      if (back) back.focus();
    }
  }

  /** R4 (H100): the grouping this browser keeps (By kind unless By operation was chosen here). */
  function readMode() {
    try { return globalThis.localStorage?.getItem(MODE_KEY) === 'operation' ? 'operation' : 'kind'; } catch { return 'kind'; }
  }
  function setMode(next) {
    mode = next === 'operation' ? 'operation' : 'kind';
    try { globalThis.localStorage?.setItem(MODE_KEY, mode); } catch { /* kept for this page only */ }
    for (const b of by ? by.querySelectorAll('button[data-by]') : []) b.setAttribute('aria-pressed', String(b.dataset.by === mode));
    shown = '';
    if (api) show(api);
  }
  if (by) {
    for (const b of by.querySelectorAll('button[data-by]')) b.setAttribute('aria-pressed', String(b.dataset.by === mode));
    by.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('button[data-by]') : null;
      if (b && by.contains(b)) setMode(b.dataset.by);
    });
  }

  /** R6 (H139): while Studio switches boards: the panel names no project's cards, and says what it waits for. */
  function hold() {
    const words = deps.hold ? deps.hold() : null;
    if (!words) return false;
    name.textContent = words;
    note.hidden = true;
    groups.replaceChildren();
    refresh.hidden = true;
    if (by) by.hidden = true;
    if (pinButton) pinButton.hidden = true;
    if (follow) follow.hidden = true;
    shown = '';
    return true;
  }
  /** R6 (H139): another project's board is on screen now: the panel starts again from it (its last reading was the board before's). */
  function reset() {
    api = null;
    shown = '';
    lastShown = null;
    readFor = '';
    void poll();
  }

  async function poll() {
    if (hold()) return;
    try { show(await read()); } catch (e) {
      name.textContent = 'not read';
      note.hidden = false;
      note.textContent = `The project could not be read: ${e instanceof Error ? e.message : String(e)}`;
      shown = '';
    }
  }

  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    refreshAll().then((r) => say(r.words), (e) => say(`Not refreshed: ${e instanceof Error ? e.message : String(e)}`, true)).finally(() => { refresh.disabled = false; });
  });
  // On a narrow or short screen the panel starts folded, so the canvas keeps its room.
  if (window.innerWidth < 600 || window.innerHeight < 640) root.open = false;
  // Every 5 s while the page is shown; R4 (H75): every 1.5 s while a drawn card's job runs or an action was just sent.
  const next = () => setTimeout(() => {
    const go = document.visibilityState === 'visible' ? poll() : Promise.resolve();
    go.finally(next);
  }, deps.fast && deps.fast() ? 1500 : 5000);
  void poll().finally(next);
  // R4 (H109): boardChanged (the canvas shows another board, or a board's pin changed)
  return { place, placeCard, placeOperation, refreshAll, poll, setMode, boardChanged, togglePin, hold, reset, get mode() { return mode; }, get api() { return api; } };
}
