// Round R4 (H55): the Project panel of Timmy Canvas. The REPL names its active project to the canvas server, and the
// server answers GET /api/project with the project's cards (src/studio/project-cards.ts), built from the board's own
// readers. This panel lists them; "Place on canvas" makes one tldraw note through the page's own editor, holding the
// card's title, state and command, with the record and receipt behind it in the note's meta; "Refresh placed cards"
// reads each placed card again from its record (its state changed: new text; its record gone: the note says so).
// "Open on the board" is a link to /board live's address while it runs: the board's token never reaches this page, the
// canvas or its saved document. Every text is set as text (textContent), never as markup.
//
// Nothing here imports anything: canvas.js hands in tldraw's helpers, so this file's pure part runs in Node's tests too.

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

/** The text a placed card holds: its title, its state and its command, one line each. */
export function cardText(card) {
  return [card.title, card.state, card.command].map((s) => String(s ?? '').replace(/\s+/g, ' ').trim()).join('\n');
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
    placedAt: now.toISOString(),
  };
}

/** A placed card's meta, or null when the shape is not one of these cards. */
export function placedMeta(shape) {
  const m = shape && shape.meta ? shape.meta[META_KEY] : undefined;
  return m && typeof m === 'object' && typeof m.card === 'string' && typeof m.projectId === 'string' ? m : null;
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
    const text = [meta.title, `record gone: ${what} is not in ${api.project.name} now (checked ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC)`, meta.command].join('\n');
    return { action: 'gone', text, meta: { ...meta, gone: true, goneAt: now.toISOString() } };
  }
  const fresh = cardMeta(card, api.project, now);
  const same = !meta.gone && ['title', 'state', 'command', 'record', 'receipt'].every((k) => fresh[k] === meta[k]);
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
 * The panel, attached to its elements in index.html. `deps`: editor() (the live editor), toRichText, createShapeId,
 * place(editor) → where a new card goes ({ x, y }, page coordinates), reveal(editor, ids).
 */
export function createProjectPanel(deps) {
  const root = document.getElementById('project');
  const name = document.getElementById('project-name');
  const note = document.getElementById('project-note');
  const said = document.getElementById('project-said');
  const groups = document.getElementById('project-groups');
  const refresh = document.getElementById('project-refresh');
  let api = null;
  let shown = '';

  async function read() {
    const response = await fetch('/api/project', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Timmy answered ${response.status} for the project`);
    return response.json();
  }

  /** Places card `id` from the project as it is now; returns what was placed. */
  async function place(id, editor = deps.editor()) {
    const now = await read();
    if (!now.project) throw new Error(now.message || 'No project is named to this canvas.');
    const card = (now.cards || []).find((c) => c.id === id);
    if (!card) throw new Error(`No card ${JSON.stringify(String(id)).slice(0, 120)} in ${now.project.name} now. Its cards: ${(now.cards || []).map((c) => c.id).join(', ').slice(0, 2000) || 'none'}.`);
    const at = deps.place(editor);
    const shapeId = deps.createShapeId();
    editor.createShape({
      id: shapeId, type: 'note', x: at.x, y: at.y,
      props: { richText: deps.toRichText(cardText(card)), size: 's', font: 'mono', align: 'start', verticalAlign: 'start' },
      meta: { [META_KEY]: cardMeta(card, now.project) },
    });
    editor.select(shapeId);
    try { deps.reveal(editor, [shapeId]); } catch { /* showing it is a courtesy */ }
    show(now);
    return { placed: true, shape: shapeId, card: { id: card.id, title: card.title, state: card.state, command: card.command, record: card.record, receipt: card.receipt }, project: now.project.name };
  }

  /** Reads every placed card again from the project's records (all pages); counts what happened. */
  async function refreshAll(editor = deps.editor()) {
    const now = await read();
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

  function say(text, bad = false) {
    said.textContent = text;
    said.dataset.kind = bad ? 'error' : 'ok';
  }

  function row(card, board) {
    const li = el('li', undefined, { className: 'pcard' });
    li.dataset.card = card.id;
    li.append(el('div', card.title, { className: 'pcard-title' }), el('div', card.state, { className: 'pcard-state' }));
    const behind = [card.record ? `record ${card.record}` : '', card.receipt ? `receipt ${card.receipt}` : ''].filter(Boolean).join(' · ');
    if (behind) li.append(el('div', behind, { className: 'pcard-behind' }));
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
      place(card.id).then((r) => say(`Placed: ${r.card.title}`), (e) => say(`Not placed: ${e instanceof Error ? e.message : String(e)}`, true)).finally(() => { put.disabled = false; });
    });
    acts.append(put);
    const href = boardHref(board, card);
    if (href) acts.append(el('a', 'Open on the board', { className: 'pcard-board', href, target: '_blank', rel: 'noopener noreferrer', title: 'The live board on this machine (/board live); it opens with the address /board live printed' }));
    li.append(cmd, acts);
    return li;
  }

  /** Draws the panel from an API answer; only when it changed, keeping the focus on the button it was on. */
  function show(now) {
    api = now;
    const sig = JSON.stringify([now.project, now.board, now.cards, now.notes, now.message]);
    if (sig === shown) return;
    shown = sig;
    const focused = document.activeElement && groups.contains(document.activeElement) ? { card: document.activeElement.closest('li')?.dataset.card, cls: document.activeElement.className } : null;
    name.textContent = now.project ? now.project.name : 'none named';
    const notes = [now.message, ...(now.notes || [])].filter(Boolean);
    note.textContent = notes.join(' ');
    note.hidden = notes.length === 0;
    refresh.hidden = !now.project;
    const parts = GROUPS.map(([kind, heading]) => {
      const cards = (now.cards || []).filter((c) => c.kind === kind);
      if (!cards.length) return null;
      const section = el('section', undefined, { className: 'pgroup' });
      section.dataset.kind = kind;
      section.append(el('h3', `${heading} (${cards.length})`), Object.assign(el('ol'), { className: 'plist' }));
      section.lastChild.append(...cards.map((c) => row(c, now.board)));
      return section;
    }).filter(Boolean);
    groups.replaceChildren(...(parts.length ? parts : now.project ? [el('p', 'No cards yet: workflows, parameter files, flows, VoxVision records and runs show here.', { className: 'pcard-empty' })] : []));
    if (focused && focused.card) {
      const back = [...groups.querySelectorAll('li.pcard')].find((li) => li.dataset.card === focused.card)?.querySelector(`.${String(focused.cls).split(' ')[0]}`);
      if (back) back.focus();
    }
  }

  async function poll() {
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
  void poll();
  setInterval(() => { if (document.visibilityState === 'visible') void poll(); }, 5000);
  return { place, refreshAll, poll, get api() { return api; } };
}
