// Round R4 (H75): Timmy Canvas's own drawn cards: a workflow card, a parameter card and a result card, tldraw shapes drawn
// from the same records the board uses (GET /api/project?detail=1, src/studio/card-detail.ts). Each says plainly whether it
// is executable now or a diagram, keeps its technical detail behind Details, and follows its record: the page reads the
// project every few seconds (faster while a job runs) and a card shows what the records say now; its shape keeps the last
// reading (and when it was taken) so a canvas reopened without Timmy shows it, said as such.
//
// Acting: a workflow card's Run, a parameter card's Save and Rebuild never run here or in the canvas server. They are sent
// to the canvas server (POST /api/project/act), which carries them to the Timmy REPL that holds the project; the REPL checks
// each against the live board's state and runs it through the live board's own path, as its own job (src/repl/canvas-
// actions.ts). A card is executable only when all of this holds: the canvas shows the card's project, a REPL takes its
// actions now, and this page has a session (it was opened by /canvas open, whose one-time grant it traded for one). Else the
// card says which is missing and gives the typed command instead of a button.
//
// The session token lives only in this module's closure (never on window, in storage, in the page's text or the canvas), and
// an action goes out only from a click the browser marks as the person's own (event.isTrusted): code run on the page through
// the agent's canvas bridge cannot press a card's buttons. Every text is set as text (React escapes it); nothing is markup.
//
// Nothing here imports anything: canvas.js hands in React and tldraw's classes, so the rules below run in Node's tests too.

/** The shape type of each drawn card, and which project card kinds each one draws. */
export const CARD_SHAPES = { workflow: 'timmy-workflow', params: 'timmy-params', result: 'timmy-result' };
const KIND_TO_TYPE = { workflow: 'workflow', params: 'params', flow: 'result', vox: 'result', run: 'result' };
const TYPE_OF_SHAPE = Object.fromEntries(Object.entries(CARD_SHAPES).map(([t, s]) => [s, t]));
const WIDTH = { workflow: 380, params: 360, result: 380 };

/** The drawn card a project card kind gets ('workflow', 'params', 'result'), or null (an unreadable record has none). */
export const drawnType = (kind) => KIND_TO_TYPE[kind] ?? null;
/** The tldraw shape type for a project card kind, or null. */
export const shapeTypeFor = (kind) => (drawnType(kind) ? CARD_SHAPES[drawnType(kind)] : null);
/** Whether a store record is one of these cards. */
export const isDrawnCard = (r) => !!r && r.typeName === 'shape' && r.type in TYPE_OF_SHAPE;

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** A result's check, in the word the card leads with. */
const CHECK_WORD = { verified: 'verified', stale: 'stale', unverified: 'not verified', none: 'receipt' };
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * What a card can do now, in words. `answer` is the last GET /api/project?detail=1 (null before the first), `session` whether
 * this page holds one. A result card is always a diagram of its record.
 */
export function cardMode(type, props, answer, session) {
  const diagram = (words, follows = false) => ({ executable: false, badge: 'diagram', words, follows });
  const name = props.project || 'its project';
  if (!answer) return diagram('Not read from Timmy yet.');
  if (!answer.project) return diagram(`Not followed now: no project is named to this canvas (in Timmy: /canvas open). Shown as last read.`);
  if (answer.project.id !== props.projectId) return diagram(`Not followed now: the canvas shows ${answer.project.name}, not ${name}. Shown as last read.`);
  const card = (answer.cards || []).find((c) => c.id === props.card);
  if (!card) return diagram(`Its record is not in ${name} now: shown as last read.`);
  if (type === 'result') return diagram('A diagram of its record, read from Timmy now: nothing runs from this card.', true);
  if (!answer.actions || answer.actions.holder !== true) return diagram(one(answer.actions?.words) || `No Timmy REPL takes ${name}'s actions now.`, true);
  if (!session) return diagram('Read from Timmy now, but this page cannot act: it was not opened by /canvas open in Timmy, or it was reloaded since. Type the command in Timmy, or /canvas open there.', true);
  return { executable: true, badge: 'executable', words: `Executable: its buttons are sent to the Timmy REPL that holds ${name}, which runs them as the live board's own actions.`, follows: true };
}

/** The live board's run action for one block of a workflow card, or null when /run cannot name it. */
export function runAct(detail, block) {
  if (!detail || detail.type !== 'workflow' || !detail.runnable) return null;
  const b = (detail.blocks || []).find((x) => x.name === block);
  return b && b.runnable ? { action: 'run', doc: detail.doc, block: b.name } : null;
}

/** The live board's rebuild action for a recipe parameter card, or null. */
export function rebuildAct(detail) {
  return detail && detail.type === 'params' && detail.rebuild && detail.recipe ? { action: 'rebuild', recipe: detail.recipe } : null;
}

/**
 * The live board's save for a parameter card: the values as typed (each as the board's own form reads it) and the sha256 the
 * file had when the card was drawn for editing (`base`), so a file changed meanwhile is refused, never written over.
 */
export function saveAct(detail, typed, base) {
  if (!detail || detail.type !== 'params' || !detail.save || !detail.save.offered) return null;
  const parameters = {};
  for (const v of detail.values || []) {
    const raw = Object.prototype.hasOwnProperty.call(typed, v.name) ? String(typed[v.name]) : String(v.value);
    const t = raw.trim();
    if (detail.engine === 'tray') parameters[v.name] = t !== '' && Number.isFinite(Number(t)) ? Number(t) : t;
    else if (v.kind === 'number') parameters[v.name] = NUMBER.test(t) ? Number(t) : raw;
    else if (v.kind === 'boolean') parameters[v.name] = t === 'true' ? true : t === 'false' ? false : raw;
    else parameters[v.name] = raw;
  }
  return detail.engine === 'tray'
    ? { action: 'set-params', recipe: detail.recipe, base: base ?? null, parameters }
    : { action: 'set-scad-params', model: detail.model, base: base ?? '', parameters };
}

/** A value as the card's field shows it. */
export const shownValue = (v) => (typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v));

/**
 * What a card keeps in its shape from a reading: the detail without what changes every second (a running run's time so far),
 * so the canvas is saved again only when the record says something new.
 */
export function keptDetail(detail) {
  if (!detail || detail.type !== 'result') return detail ?? null;
  return { ...detail, facts: (detail.facts || []).filter((f) => f.how !== 'so far') };
}

/** Whether a card's detail says a job of it still runs (the page then reads the project more often). */
export function stillRunning(detail) {
  if (!detail) return false;
  if (detail.type === 'workflow') return detail.running === true;
  if (detail.type === 'params') return !!detail.build && detail.build.tone === 'running';
  return detail.verdict && detail.verdict.tone === 'running';
}

/** A time as a card says it: the clock time (the full time is its tooltip). */
function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── the shapes and their runtime (the browser only) ────────────────────────────

/**
 * The three shape utils and the runtime that feeds and acts for them. `deps`: React, BaseBoxShapeUtil, HTMLContainer, T,
 * atom, useValue, resizeBox (from tldraw); createShapeId; editor() (the live editor); place(editor) → where a new card goes;
 * reveal(editor, ids); grant (the one-time code this page was opened with, or null).
 */
export function createCards(deps) {
  const { React, BaseBoxShapeUtil, HTMLContainer, T, atom, useValue, resizeBox } = deps;
  const h = React.createElement;
  // The fetch this module uses, taken as the page loads: code run on the page later (the agent's canvas bridge) cannot
  // wrap it to see the session's header.
  const send = window.fetch.bind(window);
  /** The last reading of the project, for every card. */
  const live = atom('timmy cards: the project as read', { answer: null, error: null });
  /** Each card's action in flight and its last answer, by shape id. */
  const acts = atom('timmy cards: actions', {});
  // The session: this closure only.
  let token = null;
  const session = atom('timmy cards: session', { state: 'none', words: 'This page was opened without a grant from Timmy: its cards cannot act.' });
  let poll = async () => {};
  let fastUntil = 0;

  const setAct = (id, v) => acts.update((all) => ({ ...all, [id]: { ...(all[id] || {}), ...v } }));

  /** Trades the grant this page was opened with for a session, once; says how it went. */
  async function startSession() {
    const grant = deps.grant;
    if (!grant) return session.get();
    try {
      const r = await send('/api/project/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant }), cache: 'no-store', credentials: 'omit' });
      const body = await r.json();
      if (r.ok && body.ok === true && typeof body.token === 'string' && /^[0-9a-f]{64}$/.test(body.token)) {
        token = body.token;
        session.set({ state: 'ok', words: 'This page was opened by Timmy: its executable cards can act.' });
      } else {
        session.set({ state: 'refused', words: one(body.error) || `Timmy answered ${r.status} for this page's grant.` });
      }
    } catch (e) {
      session.set({ state: 'refused', words: `The grant could not be traded: ${e instanceof Error ? e.message : String(e)}` });
    }
    return session.get();
  }

  /** One action of one card, sent to the REPL that holds the project; the answer is kept on the card. */
  async function act(shapeId, body) {
    if (!token) { setAct(shapeId, { busy: false, answer: { ok: false, text: 'This page has no session: /canvas open in Timmy opens one that has.' } }); return; }
    setAct(shapeId, { busy: true, answer: null });
    let answer;
    try {
      const r = await send('/api/project/act', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit',
      });
      const got = await r.json().catch(() => ({}));
      answer = { ok: r.ok && got.ok === true, status: r.status, text: one(got.text) ? String(got.text) : one(got.error) || `Timmy answered ${r.status}.`, act: body.act.action };
    } catch (e) {
      answer = { ok: false, status: 0, text: `The action did not reach Timmy Canvas: ${e instanceof Error ? e.message : String(e)}`, act: body.act.action };
    }
    setAct(shapeId, { busy: false, answer, ...(answer.ok && body.act.action.startsWith('set-') ? { saved: Date.now() } : {}) });
    fastUntil = Date.now() + 60_000;
    void poll();
  }

  /**
   * Every button that acts goes through here, from the browser's own click event: only a click the browser marks as the
   * person's (a pointer, or Enter or Space on the focused button) acts; one made by script (element.click(), a dispatched
   * event) is ignored.
   */
  function onClick(e) {
    if (!(e instanceof MouseEvent) || e.isTrusted !== true) return;
    const b = e.target instanceof Element ? e.target.closest('button[data-tc-act]') : null;
    if (!b || b.disabled) return;
    const root = b.closest('[data-timmy-card]');
    const editor = deps.editor();
    const shape = root && editor ? editor.getShape(root.getAttribute('data-timmy-card')) : null;
    if (!shape || !isDrawnCard(shape)) return;
    const type = TYPE_OF_SHAPE[shape.type];
    const now = live.get().answer;
    const mode = cardMode(type, shape.props, now, token !== null);
    if (!mode.executable) return;
    const card = (now.cards || []).find((c) => c.id === shape.props.card);
    const detail = card && card.detail;
    const what = b.getAttribute('data-tc-act');
    let a = null;
    if (what === 'run') a = runAct(detail, b.getAttribute('data-tc-block'));
    else if (what === 'rebuild') a = rebuildAct(detail);
    else if (what === 'save') {
      const typed = {};
      for (const f of root.querySelectorAll('[data-tc-param]')) typed[f.getAttribute('data-tc-param')] = f.value;
      const form = root.querySelector('[data-tc-base]');
      a = saveAct(detail, typed, form ? form.getAttribute('data-tc-base') || null : detail && detail.base);
    }
    if (a) void act(shape.id, { project: shape.props.projectId, card: shape.props.card, act: a });
  }
  if (typeof document !== 'undefined') document.addEventListener('click', onClick, true);

  /** A reading of the project: every card follows it, and each placed card keeps it (only what changed is written). */
  function onAnswer(answer) {
    live.set({ answer, error: null });
    const editor = deps.editor();
    if (!editor || !answer || !answer.project) return;
    const updates = [];
    for (const r of editor.store.allRecords()) {
      if (!isDrawnCard(r) || r.props.projectId !== answer.project.id) continue;
      const card = (answer.cards || []).find((c) => c.id === r.props.card);
      if (!card) {
        if (!r.props.gone) updates.push({ id: r.id, type: r.type, props: { gone: true, readAt: answer.madeAt } });
        continue;
      }
      const kept = keptDetail(card.detail);
      if (r.props.gone || JSON.stringify(kept) !== JSON.stringify(r.props.data) || r.props.title !== card.title || r.props.command !== card.command) {
        updates.push({ id: r.id, type: r.type, props: { data: kept, readAt: answer.madeAt, gone: false, title: card.title, command: card.command } });
      }
    }
    if (updates.length) editor.run(() => editor.updateShapes(updates), { history: 'ignore' });
  }

  /** Whether the page should read the project again soon (a job of a card runs, or an action was just sent). */
  function wantsFast() {
    if (Date.now() < fastUntil) return true;
    const a = live.get().answer;
    const editor = deps.editor();
    if (!a || !editor) return false;
    return editor.store.allRecords().some((r) => isDrawnCard(r) && r.props.projectId === a.project?.id && stillRunning((a.cards || []).find((c) => c.id === r.props.card)?.detail));
  }

  /** Places card `id` of the project as it is now, as its drawn card. */
  async function place(id, answer, editor = deps.editor()) {
    if (!answer.project) throw new Error(answer.message || 'No project is named to this canvas.');
    const card = (answer.cards || []).find((c) => c.id === id);
    if (!card) throw new Error(`No card ${JSON.stringify(String(id)).slice(0, 120)} in ${answer.project.name} now.`);
    const type = drawnType(card.kind);
    if (!type) throw new Error(`${card.title} has no drawn card (an unreadable record): Place on canvas makes a note of it.`);
    // Beside the drawn cards already on this page (right of the rightmost), so cards placed one after another never cover
    // each other; the first goes where the panel's notes go.
    const others = editor.getCurrentPageShapes().filter(isDrawnCard).map((s) => editor.getShapePageBounds(s.id)).filter(Boolean);
    const right = others.reduce((a, b) => (!a || b.maxX > a.maxX ? b : a), null);
    const at = right ? { x: Math.round(right.maxX + 32), y: Math.round(right.minY) } : deps.place(editor);
    const shapeId = deps.createShapeId();
    editor.createShape({
      id: shapeId, type: CARD_SHAPES[type], x: at.x, y: at.y,
      props: { w: WIDTH[type], h: 160, card: card.id, kind: card.kind, projectId: answer.project.id, project: answer.project.name, title: card.title, command: card.command, data: keptDetail(card.detail), readAt: answer.madeAt, open: false, gone: false },
    });
    editor.select(shapeId);
    try { deps.reveal(editor, [shapeId]); } catch { /* showing it is a courtesy */ }
    return { placed: true, shape: shapeId, type: CARD_SHAPES[type], card: { id: card.id, title: card.title } };
  }

  // ── drawing ──
  const handled = (e) => { const ed = deps.editor(); if (ed) ed.markEventAsHandled(e); };
  const span = (cls, text, extra = {}) => h('span', { className: cls, ...extra }, text);
  const cmd = (text) => h('code', { className: 'tc-cmd', title: 'Type this in Timmy' }, text);
  const words = (cls, text) => (one(text) ? h('p', { className: cls }, text) : null);
  const toneClass = (tone) => (tone === 'failed' ? 'tc-bad' : tone === 'attention' ? 'tc-warn' : '');

  /** The card's frame: its head (title, badge), its mode in words, its body, Details, the last answer and its reading. */
  function Frame({ shape, type, mode, children, details, follows, answer, readAt }) {
    const ref = React.useRef(null);
    const p = shape.props;
    // The shape's height follows its content (the width is the person's): written without an undo step.
    React.useLayoutEffect(() => {
      const el = ref.current;
      const editor = deps.editor();
      if (!el || !editor) return undefined;
      const fit = () => {
        const want = Math.max(80, Math.ceil(el.scrollHeight) + 2);
        const now = editor.getShape(shape.id);
        if (now && Math.abs(now.props.h - want) > 1) editor.run(() => editor.updateShape({ id: shape.id, type: shape.type, props: { h: want } }), { history: 'ignore' });
      };
      fit();
      if (typeof ResizeObserver === 'undefined') return undefined;
      const ro = new ResizeObserver(fit);
      ro.observe(el);
      return () => ro.disconnect();
    }, [shape.id, shape.type]);
    const toggle = () => { const ed = deps.editor(); if (ed) ed.updateShape({ id: shape.id, type: shape.type, props: { open: !p.open } }); };
    const busy = answer && answer.busy;
    const said = answer && answer.answer;
    // The answer's first lines on the card; all of it under Details.
    const lines = said ? said.text.split('\n') : [];
    const shown = lines.length > 8 ? `${lines.slice(0, 8).join('\n')}\n… ${lines.length - 8} more lines under Details` : lines.join('\n');
    return h(HTMLContainer, { className: `tc tc-${type}`, 'data-timmy-card': shape.id, style: { width: p.w, height: p.h, pointerEvents: 'all' } },
      h('div', { ref, className: 'tc-inner', role: 'group', 'aria-label': `${type} card: ${p.title}` },
        h('div', { className: 'tc-head' },
          h('strong', { className: 'tc-title' }, p.title || p.card),
          span(`tc-badge tc-${mode.badge}`, mode.badge)),
        h('p', { className: `tc-mode${mode.executable ? ' tc-mode-on' : ''}` }, mode.words),
        ...React.Children.toArray(children),
        busy ? h('p', { className: 'tc-answer', role: 'status' }, 'Sent to Timmy; waiting for its answer…') : null,
        said ? h('pre', { className: `tc-answer${said.ok ? '' : ' tc-bad'}`, role: 'status' }, shown) : null,
        h('div', { className: 'tc-foot' },
          h('button', { type: 'button', className: 'tc-toggle', 'aria-expanded': String(!!p.open), onPointerDown: handled, onClick: toggle }, p.open ? 'Hide details' : 'Details'),
          span('tc-read', follows ? `read from Timmy's records at ${clock(readAt)}` : p.readAt ? `as last read at ${clock(p.readAt)}` : 'never read', { title: follows ? readAt : p.readAt })),
        p.open ? h('div', { className: 'tc-details' }, ...React.Children.toArray([details].flat()), said && lines.length > 8 ? h('pre', { className: 'tc-answer' }, said.text) : null) : null));
  }

  /** The values of `rows` as a definition list (technical detail). */
  const dl = (rows) => h('dl', { className: 'tc-dl' }, ...rows.filter(Boolean).flatMap(([k, v]) => [h('dt', { key: `k${k}` }, k), h('dd', { key: `v${k}` }, v)]));

  function useCard(shape, type) {
    const now = useValue('timmy cards: reading', () => live.get().answer, []);
    const own = useValue('timmy cards: this card\'s action', () => acts.get()[shape.id] ?? null, [shape.id]);
    const sess = useValue('timmy cards: session', () => session.get(), []);
    const p = shape.props;
    const mode = cardMode(type, p, now, sess.state === 'ok' && token !== null);
    const card = mode.follows ? (now.cards || []).find((c) => c.id === p.card) : null;
    const detail = (card && card.detail) || p.data;
    return { now, own, mode, card, detail, readAt: now ? now.madeAt : p.readAt };
  }

  function WorkflowCard({ shape }) {
    const { own, mode, detail, readAt } = useCard(shape, 'workflow');
    const p = shape.props;
    const d = detail && detail.type === 'workflow' ? detail : null;
    const busy = !!(own && own.busy);
    const blocks = d ? d.blocks : [];
    const runOf = (b) => (mode.executable && d.runnable && b.runnable
      ? h('button', { type: 'button', className: 'tc-btn', 'data-tc-act': 'run', 'data-tc-block': b.name, disabled: busy, onPointerDown: handled, title: `Sends /run ${d.doc} ${b.name} to Timmy (Run up to here)` }, 'Run up to here')
      : d.runnable && b.runnable ? cmd(`/run ${d.doc} ${b.name}`) : span('tc-note', '/run cannot name this block as one word'));
    const last = d && d.last;
    return h(Frame, {
      shape, type: 'workflow', mode, follows: mode.follows, answer: own, readAt,
      details: d ? [
        dl([['document', d.doc], ['sha256', d.sha256 || 'not hashed'], ['card', p.card], ['project', `${p.project} (${p.projectId})`],
          last ? ['newest run', `job ${last.job}${last.predicted ? ` · prediction receipt ${last.predicted}` : ''}${last.receipt ? ` · outcome receipt ${last.receipt}` : ''}`] : null,
          last && last.note ? ['its record says', last.note] : null, last && last.error ? ['error', last.error] : null]),
        ...blocks.map((b) => h('div', { key: `c${b.key}`, className: 'tc-block-cmd' }, span('tc-k', `${b.name}${b.needs.length ? ` (needs ${b.needs.join(', ')})` : ''}`), ...b.command.map((l, i) => h('code', { key: i }, l)))),
        ...(last ? last.outputs.map((o) => h('div', { key: `o${o.path}`, className: 'tc-out' }, span('tc-path', o.path), ' ', span('tc-note', o.now))) : []),
        last && last.more ? words('tc-note', `${last.more} more files`) : null,
      ] : words('tc-note', 'No reading of this document yet.'),
    },
    d ? h('ol', { className: 'tc-blocks' }, ...blocks.map((b) => h('li', { key: b.key, className: `tc-block tc-w-${String(b.word).replace(/[^a-z]/g, '')}` },
      span('tc-glyph', b.glyph, { 'aria-hidden': 'true' }), ' ', span('tc-name', b.name), ' ', span(`tc-word ${b.word === 'failed' || b.word === 'interrupted' ? 'tc-bad' : ''}`, b.word),
      b.detail ? span('tc-note', ` · ${b.detail}`) : null, h('div', { className: 'tc-acts' }, runOf(b))))) : words('tc-note', p.command),
    last ? h('p', { className: 'tc-last' }, `Newest run (${last.target}): `, span(last.word === 'failed' || last.word === 'interrupted' ? 'tc-bad' : '', last.word),
      `${last.met === true ? ', its prediction met' : last.met === false ? ', its prediction not met' : ''}${last.took ? ` · ${last.took}` : ''}${last.receipt ? ` · receipt ${last.receipt}` : ''}`) : d ? words('tc-note', 'Not run yet.') : null);
  }

  function ParamsCard({ shape }) {
    const { own, mode, detail, readAt } = useCard(shape, 'params');
    const p = shape.props;
    const d = detail && detail.type === 'params' ? detail : null;
    // Values typed here (by name), and the reading they were typed over: Save sends that reading's sha256 as its base.
    const [typed, setTyped] = React.useState({});
    const [over, setOver] = React.useState(null);
    const saved = own && own.saved;
    React.useEffect(() => { if (saved) { setTyped({}); setOver(null); } }, [saved]);
    const view = over || d;
    const editable = !!(mode.executable && d && d.save.offered);
    const dirty = Object.keys(typed).some((n) => { const v = (view.values || []).find((x) => x.name === n); return v && typed[n].trim() !== shownValue(v.value); });
    const busy = !!(own && own.busy);
    const field = (v) => {
      if (!editable) return span('tc-value', `${shownValue(v.value)}${v.unit ? ` ${v.unit}` : ''}`);
      const value = Object.prototype.hasOwnProperty.call(typed, v.name) ? typed[v.name] : shownValue(v.value);
      const onChange = (e) => { if (!over) setOver(d); setTyped({ ...typed, [v.name]: e.target.value }); };
      const common = { className: 'tc-input', 'data-tc-param': v.name, value, onChange, onPointerDown: handled, 'aria-label': `${v.name}${v.unit ? ` in ${v.unit}` : ''}` };
      return v.kind === 'boolean'
        ? h('select', common, h('option', { value: 'true' }, 'true'), h('option', { value: 'false' }, 'false'))
        : h('input', { ...common, type: 'text', inputMode: v.kind === 'number' ? 'decimal' : 'text', spellCheck: false, size: 8 });
    };
    // Each value with its unit beside it, and its meaning and range under it.
    const rows = view ? (view.values || []).flatMap((v) => [
      h('tr', { key: `v${v.name}` }, h('th', { scope: 'row' }, v.name), h('td', null, field(v), editable && v.unit ? span('tc-note', ` ${v.unit}`) : null, v.default !== undefined ? span('tc-note', ` (default ${shownValue(v.default)})`) : null)),
      ...(v.help ? [h('tr', { key: `h${v.name}`, className: 'tc-help-row' }, h('td', null), h('td', { className: 'tc-help' }, v.help))] : []),
    ]) : [];
    const build = d && d.build;
    const stateWords = !d ? p.command : d.state === 'ok' ? `saved in ${d.file}` : d.state === 'none' ? `no ${d.file} yet: ${d.engine === 'tray' ? 'the recipe\'s own defaults' : 'the model\'s own values'}` : `not usable: ${d.error}`;
    return h(Frame, {
      shape, type: 'params', mode, follows: mode.follows, answer: own, readAt,
      details: d ? [dl([['file', d.file], ['sha256', d.base || 'no file'], ['card', p.card], ['project', `${p.project} (${p.projectId})`],
        d.fixed ? ['fixed', `${d.fixed}${d.units ? ` (${d.units})` : ''}`] : null, ['run it', d.run], ['saving', d.save.offered ? 'through the live board\'s save path: checked by the recipe\'s rules, refused while a flow runs here, the previous version kept, an edit receipt' : d.save.why],
        over ? ['editing over', `sha256 ${String(over.base).slice(0, 12)}: a save is refused if the file changed since`] : null]),
      ...(build ? [dl([['newest build', `${build.title} · ${build.word}`], ...build.facts.map((f) => [f.label, `${f.value} (${f.how})`]), ...build.receipts.map((r) => ['receipt', r]), ...build.files.map((f) => [f.note || 'file', f.path])])] : []),
      ] : words('tc-note', 'No reading of this file yet.'),
    },
    words('tc-state', stateWords),
    view ? h('form', { className: 'tc-form', 'data-tc-base': over ? over.base ?? '' : d.base ?? '', onSubmit: (e) => e.preventDefault() },
      h('table', { className: 'tc-table' }, h('tbody', null, ...rows)),
      d && d.more ? words('tc-note', `${d.more} more values: /open ${d.file}`) : null) : null,
    d ? h('div', { className: 'tc-acts' },
      editable ? h('button', { type: 'button', className: 'tc-btn', 'data-tc-act': 'save', disabled: busy || !(dirty || d.state === 'unusable'), onPointerDown: handled, title: 'Sends the live board\'s parameter save to Timmy' }, 'Save') : null,
      editable && dirty ? h('button', { type: 'button', className: 'tc-btn tc-quiet', onPointerDown: handled, onClick: () => { setTyped({}); setOver(null); } }, 'Discard') : null,
      mode.executable && d.rebuild ? h('button', { type: 'button', className: 'tc-btn', 'data-tc-act': 'rebuild', disabled: busy || dirty, onPointerDown: handled, title: dirty ? 'Save first: Rebuild uses the saved file' : `Sends Rebuild (${d.run}) to Timmy` }, 'Rebuild') : null,
      !mode.executable || !d.save.offered ? cmd(d.run) : null,
      !editable && d.state !== 'none' ? cmd(`/open ${d.file}`) : null,
      mode.executable && !d.save.offered ? words('tc-note', d.save.why) : null) : null,
    build ? h('div', { className: 'tc-build' },
      h('p', null, 'Newest build: ', span(toneClass(build.tone), build.word), build.detail ? span('tc-note', ` · ${build.detail}`) : null),
      ...build.facts.slice(0, 3).map((f) => h('p', { key: f.label, className: 'tc-fact' }, `${f.label} ${f.value}`, span('tc-note', ` · ${f.how}`)))) : null,
    d && d.notice ? h('p', { className: 'tc-notice' }, d.notice) : null);
  }

  function ResultCard({ shape }) {
    const { own, mode, detail, readAt } = useCard(shape, 'result');
    const p = shape.props;
    const d = detail && detail.type === 'result' ? detail : null;
    return h(Frame, {
      shape, type: 'result', mode, follows: mode.follows, answer: own, readAt,
      details: d ? [dl([['card', p.card], ['project', `${p.project} (${p.projectId})`], ['check', d.check.words], d.check.receipt ? ['receipt', d.check.receipt] : null,
        d.started ? ['started', d.started] : null, d.ended ? ['ended', d.ended] : null, ['command', p.command]]),
      ...d.outputs.map((o) => h('div', { key: `s${o.path}`, className: 'tc-out' }, span('tc-path', o.path), ' ', span('tc-note', `${o.sha256 ? `sha256 ${o.sha256}` : 'no sha256 recorded'}${o.bytes !== null ? ` · ${o.bytes} bytes` : ''}`))),
      ...d.lines.map((l, i) => h('p', { key: `l${i}`, className: 'tc-note' }, l)),
      ] : words('tc-note', 'No reading of this record yet.'),
    },
    d ? h('p', { className: 'tc-verdict' }, span(toneClass(d.verdict.tone), d.verdict.words)) : words('tc-note', p.command),
    d ? h('p', { className: `tc-check tc-check-${d.check.status}` }, span('tc-k', CHECK_WORD[d.check.status] ?? d.check.status), ` · ${d.check.words}`) : null,
    d && d.facts.length ? h('dl', { className: 'tc-dl' }, ...d.facts.flatMap((f, i) => [h('dt', { key: `k${i}` }, f.label), h('dd', { key: `v${i}` }, f.value, ' ', span('tc-note', f.how))])) : null,
    d && d.images.length ? h('div', { className: 'tc-images' }, ...d.images.map((im) => (mode.follows
      ? h('img', { key: im.path, src: `/api/project/image?p=${encodeURIComponent(im.path)}`, alt: `highlight ${im.path}`, title: im.path, draggable: false })
      : span('tc-note', `highlight ${im.path}: shown while the canvas follows ${p.project}`, { key: im.path })))) : null,
    d && d.outputs.length ? h('ul', { className: 'tc-outs' }, ...d.outputs.map((o) => h('li', { key: o.path }, span('tc-path', o.path), ' ', span('tc-note', `${o.sha256 ? `sha256 ${o.sha256.slice(0, 12)} · ` : ''}${o.now}`)))) : null,
    d && d.notice ? h('p', { className: 'tc-notice' }, d.notice) : null,
    h('div', { className: 'tc-acts' }, cmd(p.command)));
  }

  const props = {
    w: T.number, h: T.number, card: T.string, kind: T.string, projectId: T.string, project: T.string, title: T.string, command: T.string,
    data: T.jsonValue, readAt: T.string, open: T.boolean, gone: T.boolean,
  };
  const defaults = (type) => ({ w: WIDTH[type], h: 160, card: '', kind: '', projectId: '', project: '', title: '', command: '', data: null, readAt: '', open: false, gone: false });
  const make = (type, Component) => {
    class CardUtil extends BaseBoxShapeUtil {
      static type = CARD_SHAPES[type];
      static props = props;
      getDefaultProps() { return defaults(type); }
      hideRotateHandle() { return true; }
      canEdit() { return false; }
      // The width is the person's; the height follows the content.
      onResize(shape, info) { const next = resizeBox(shape, info); return { ...next, y: shape.y, props: { ...next.props, h: shape.props.h } }; }
      getText(shape) { return `${shape.props.title}\n${shape.props.command}`; }
      component(shape) { return h(Component, { shape }); }
      getIndicatorPath(shape) { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path; }
    }
    return CardUtil;
  };
  const utils = [make('workflow', WorkflowCard), make('params', ParamsCard), make('result', ResultCard)];
  return {
    utils, startSession, onAnswer, wantsFast, place,
    setPoll: (f) => { poll = f; },
    /** For the tests and the status line: the session in words (never the token). */
    session: () => session.get(),
  };
}
