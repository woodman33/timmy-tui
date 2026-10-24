// R11 round 5 (H174): the "Inspect animation" view — for each Rive component: the actual .riv asset (name, size, sha256 short),
// the artboard and state-machine names the RUNTIME reports (rive.js: contents / stateMachineNames / stateMachineInputs), each
// input with its type and CURRENT value, the last binding events (input, value, time, backend source), the editable source
// listed beside the asset, and a PREVIEW control per state LABELLED "Preview playback — not an execution, no progress, no
// receipt" that only moves the animation (TimmyRive.preview: it writes no state anywhere, shows no receipt, no progress number).
//
// Mounted through H171's shell when the shell knows an 'inspect' screen (TimmyShell.mount('inspect', draw)); until then it
// shows itself on the #inspect fragment in its own section (Close clears the fragment) and touches no other screen.
// Reads: GET /api/rive/assets through TimmyShell.fetch (the launch token + session), GET /assets/mark.json (the T mark).
(() => {
  'use strict';
  const SCREEN = 'inspect';
  const WORDS_PATH = '/assets/mark.json';
  const LISTING = '/api/rive/assets';
  const PREVIEW_LABEL = 'Preview playback — not an execution, no progress, no receipt';
  /** The T mark (H171's, src/companion/assets/mark/) as the Inspect view lists it beside the components. */
  const MARK = { component: 'mark', asset: '/assets/timmy-mark.riv', artboard: 'TimmyMark', stateMachine: 'TimmyVisual', sources: ['scene.rml', 'rive.yaml', 'README.md'], base: '/assets/' };
  /**
   * What each component is in the page: its role, its binds, its heading (the vocabulary is the state machine's input), and
   * the artboard it takes on the operator's native asset (src/companion/assets/rive/timmy-ui/timmy-ui.riv: one state machine
   * TimmyUI on each artboard; the contract in its README) when that asset is listed with its .riv; else the drafted folder's.
   */
  const NATIVE = 'timmy-ui';
  const KNOWN = {
    welcome: { role: 'button', heading: 'Welcome / guide', label: 'Timmy’s welcome: press to play the guide', text: 'T', input: 'welcome', artboard: 'ActionButton' },
    connection: { role: 'img', heading: 'Provider connection', text: '○', input: 'connection', providers: ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'], artboard: 'ProviderCard' },
    activity: { role: 'img', heading: 'Agent / tool activity', text: '>_', input: 'activity', artboard: 'AgentConsole' },
    mark: { role: 'img', heading: 'The T mark', text: 'T', input: null },
  };
  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : String(v)); }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };
  const shell = () => (typeof window.TimmyShell !== 'undefined' ? window.TimmyShell : null);
  const fetcher = (url) => { const s = shell(); if (s && typeof s.fetch === 'function') return s.fetch(url); if (typeof companion !== 'undefined' && companion && companion.fetch) return companion.fetch(url); return fetch(url, { cache: 'no-store', credentials: 'omit' }); };
  const clock = (iso) => { try { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; } catch (e) { return String(iso); } };

  /** The handles this view made, by component key (made once; redrawn in place). */
  const made = {};
  let listing = null; // the last GET /api/rive/assets answer, or { status, words }
  let mark = null;    // the last GET /assets/mark.json
  let timer = 0;

  /** The component's handle in the view (made once), bound to its backend feed. */
  function handleFor(key, c, host) {
    if (made[key]) { if (made[key].root && made[key].root.parentNode !== host) host.append(made[key].root); return made[key]; }
    const R = window.TimmyRive;
    const known = KNOWN[c.kind] || KNOWN.mark;
    const binds = c.kind === 'connection' ? [`connection:${c.provider}`] : c.kind === 'activity' ? ['activity'] : [];
    const handle = R.component({
      host, component: key, asset: c.asset, artboard: c.artboard || null, stateMachine: c.stateMachine || null, role: known.role,
      label: c.kind === 'connection' ? `Connection to ${c.provider}` : known.label || known.heading, heading: c.kind === 'connection' ? `${known.heading} · ${c.provider}` : known.heading,
      text: known.text, binds, sources: c.sources || [], triggerInput: known.input === 'welcome' ? 'welcome' : null,
      word: c.kind === 'connection' ? 'disconnected' : c.kind === 'activity' ? 'idle' : 'drawn by its file, or the text mark',
    });
    made[key] = handle;
    return handle;
  }

  /** One input's current value, in words. */
  const valueWords = (i) => (i.type === 'Trigger' ? '(a trigger: fires)' : i.value === null || i.value === undefined ? '—' : String(i.value));

  /** The facts of one component, as the runtime and the bindings report them now. */
  function facts(handle, c) {
    const R = window.TimmyRive;
    const info = R.inspect().find((x) => x.id === handle.id);
    const rt = info && info.runtime;
    const riv = c.riv;
    const base = c.base || `/assets/rive/${c.folder}/`;
    const rows = [];
    rows.push(['Asset', riv ? h('span', null, h('code', null, riv.name), typeof riv.bytes === 'number' ? ` · ${riv.bytes} bytes · sha256 ${riv.sha256}` : ` · served at ${c.asset || c.path}`, c.artboard ? ` · artboard ${c.artboard}` : '') : h('span', { class: 'sh-note' }, c.folder === 'mark' ? 'timmy-mark.riv is not in this installation' : `${c.folder}.riv is not in this installation (the source beside it is; the .riv is compiled by the Rive tooling, not here)`)]);
    rows.push(['Runtime', h('span', { 'data-inspect-runtime': handle.component }, info ? (info.state === 'drawn' ? 'drawn by @rive-app/canvas (this origin, /vendor/rive/)' : info.state === 'loading' ? 'loading…' : `words only — ${info.why || 'no file or no runtime'}`) : '—')]);
    rows.push(['Artboards (runtime)', rt ? (rt.artboardNames.length ? rt.artboardNames.join(', ') : '(the runtime reports none)') : h('span', { class: 'sh-note' }, `not reported (no file loaded); the source names ${c.artboard || '—'}`)]);
    rows.push(['State machines (runtime)', rt ? (rt.stateMachineNames.length ? rt.stateMachineNames.join(', ') : '(none)') : h('span', { class: 'sh-note' }, `not reported; the source names ${c.stateMachine || '—'}`)]);
    rows.push(['Animations (runtime)', rt ? (rt.animationNames.length ? rt.animationNames.join(', ') : '(none)') : '—']);
    rows.push(['Inputs (runtime: type · current value)', rt && rt.inputs.length ? h('ul', { class: 'tr-inputs' }, ...rt.inputs.map((i) => h('li', { 'data-inspect-input': i.name }, h('code', null, i.name), ` · ${i.type} · `, h('b', null, valueWords(i))))) : h('span', { class: 'sh-note' }, rt ? '(the state machine has no inputs)' : `not reported; the source declares: ${(c.inputs && c.inputs.length ? c.inputs : ['—']).join(', ')}`)]);
    rows.push(['Binding state (this page)', h('span', { 'data-inspect-values': handle.component }, Object.keys(handle.values).length ? Object.entries(handle.values).map(([k, v]) => { const n = R.nativeOf(handle, k, v); return `${k} = ${JSON.stringify(v)}${n ? ` → ${n.name} ${JSON.stringify(n.value)}${n.note ? ` (${n.note})` : ''}` : ' (HTML only)'}`; }).join(' · ') : 'nothing set yet')]);
    if (info && info.contract) rows.push(['Native contract', h('span', { 'data-inspect-contract': handle.component }, `TimmyUI on ${c.artboard}: State 0 Idle · 1 Working/Checking · 2 Approval · 3 Stopped · 4 Failed; Hover, Pressed, ReducedMotion (Bool). This page's words map onto it (${c.kind === 'connection' ? 'connected has NO success pose: State 0, the label says it' : c.kind === 'activity' ? 'stopping → State 1 until the backend says cancelled → 3' : 'the press → Pressed down, then up'}); the drafted source ${c.draft ? `in ${c.draft.folder}/ stays as a draft` : 'is beside the asset'}.`)]);
    rows.push(['Reduced motion', handle.still ? (info && info.nativeReduced ? 'on: the asset’s own ReducedMotion input is true (zero-duration transitions; the runtime settles each pose and stops moving)' : 'on: the runtime is paused on its first frame (the words carry the state)') : 'off: the runtime plays']);
    rows.push(['Editable source', h('span', { class: 'tr-sources' }, ...(c.sources && c.sources.length ? c.sources.map((s, i) => h('span', null, i ? ' · ' : '', h('a', { href: `${base}${s}`, target: '_blank', rel: 'noopener' }, s))) : ['none listed']))]);
    return h('dl', { class: 'tr-facts' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  }

  /** The last binding events: input, value, time, source. */
  function events(handle) {
    const list = handle.events.slice(-12).reverse();
    return h('div', { class: 'tr-events' }, h('h4', null, 'Binding events (newest first)'),
      list.length ? h('ol', { 'data-inspect-events': handle.component }, ...list.map((e) => h('li', { 'data-event-source': e.source }, h('code', null, `${e.input} = ${JSON.stringify(e.value)}`), e.native ? h('span', { class: 'tr-native' }, ` → ${e.native.input} ${JSON.stringify(e.native.value)}`) : null, ` · ${clock(e.at)} · `, h('span', { class: e.source.startsWith('PREVIEW') ? 'tr-src-preview' : e.source.startsWith('derived') ? 'tr-src-derived' : 'tr-src' }, e.source), ` · ${e.did}`)))
        : h('p', { class: 'sh-note' }, 'No binding event yet: the inputs move only when a backend event arrives (or a preview is pressed).'));
  }

  /** The PREVIEW controls: one per word of the component's vocabulary; labelled; they move the animation only. */
  function previews(handle, c) {
    const R = window.TimmyRive;
    const known = KNOWN[c.kind] || KNOWN.mark;
    if (!known.input) return h('p', { class: 'sh-note' }, 'No preview control: the mark has one Idle animation and no operational input.');
    const vocab = R.VOCAB[known.input] || [];
    const buttons = known.input === 'welcome'
      ? [h('p', { class: 'sh-note' }, 'The welcome is a user trigger: press the component itself (click, Enter or Space). No preview fires it for you.')]
      : vocab.map((w) => h('button', { type: 'button', class: 'sh-btn is-small tr-preview', 'data-preview': `${handle.component}:${w}`, 'aria-describedby': `tr-preview-label-${handle.component}` }, `Preview: ${w}`));
    return h('div', { class: 'tr-previews', role: 'group', 'aria-label': PREVIEW_LABEL },
      h('p', { class: 'sh-label tr-preview-label', id: `tr-preview-label-${handle.component}` }, 'PREVIEW'),
      h('p', { class: 'sh-note', 'data-preview-words': handle.component }, PREVIEW_LABEL),
      h('div', { class: 'sh-actions' }, ...buttons),
      ...(known.input === 'selected' || known.input === 'welcome' ? [] : [h('div', { class: 'sh-actions' }, h('button', { type: 'button', class: 'sh-btn is-small tr-preview', 'data-preview': `${handle.component}:selected` }, 'Preview: selected ⇄'), h('button', { type: 'button', class: 'sh-btn is-small tr-preview', 'data-preview': `${handle.component}:expanded` }, 'Preview: expanded ⇄'))]));
  }

  /** One component's card. */
  function card(key, c, host) {
    const art = h('div', { class: 'tr-art' });
    const handle = handleFor(key, c, art);
    const box = h('article', { class: 'sh-card tr-card', 'data-inspect-component': key, 'aria-labelledby': `tr-h-${key}` },
      h('h3', { id: `tr-h-${key}` }, (KNOWN[c.kind] || KNOWN.mark).heading + (c.provider ? ` · ${c.provider}` : '')),
      art, facts(handle, c), events(handle), previews(handle, c));
    host.append(box);
    return handle;
  }

  /** The components to list: the T mark, then each folder of GET /api/rive/assets (connection ×4 from its one source). */
  function components() {
    // (the mark's file is asked for only when GET /assets/mark.json says it is there: no 404 on every open of this view)
    const out = [{ key: 'mark', kind: 'mark', folder: 'mark', asset: mark && mark.mark ? MARK.asset : null, artboard: MARK.artboard, stateMachine: MARK.stateMachine, sources: MARK.sources, base: MARK.base, riv: mark && mark.mark ? { name: 'timmy-mark.riv' } : null, path: MARK.asset }];
    const rows = listing && Array.isArray(listing.components) ? listing.components : [];
    // the operator's native asset, when it is here with its .riv: every component takes its artboard on it
    const native = rows.find((r) => r.component === NATIVE && r.riv);
    for (const row of rows) {
      if (row.component === NATIVE) continue;
      const meta = row.meta || {};
      const kind = KNOWN[row.component] ? row.component : null;
      if (!kind) continue;
      const base = native
        ? { folder: NATIVE, asset: `/assets/rive/${NATIVE}/${native.riv.name}`, artboard: KNOWN[kind].artboard, stateMachine: (native.meta && native.meta.stateMachine) || 'TimmyUI', inputs: (native.meta && native.meta.inputs) || ['State', 'Hover', 'Pressed', 'ReducedMotion'], sources: native.sources, riv: native.riv, draft: { folder: row.component, sources: row.sources } }
        : { folder: row.component, asset: `/assets/rive/${row.component}/${row.riv ? row.riv.name : `${row.component}.riv`}`, artboard: meta.artboard, stateMachine: meta.stateMachine, inputs: meta.inputs, sources: row.sources, riv: row.riv };
      if (kind === 'connection') for (const p of KNOWN.connection.providers) out.push({ ...base, key: `connection-${p}`, kind, provider: p });
      else out.push({ ...base, key: row.component, kind });
    }
    return out;
  }

  let hostEl = null;
  function draw(host) {
    hostEl = host;
    const R = window.TimmyRive;
    host.replaceChildren(
      h('div', { class: 'sh-head' }, h('span', { class: 'sh-head-brand' }, 'TIMMY'), h('span', { class: 'sh-head-words' }, 'Inspect animation')),
      h('div', { class: 'sh-main tr-main' },
        h('h2', { class: 'tr-title' }, 'Inspect animation'),
        h('p', { class: 'sh-note' }, 'What each Rive component is, as the runtime reports it: the .riv asset, its artboards, state machines and inputs with their current values, the backend events that moved them, and the editable source beside the asset. A state here comes from a backend event (GET /api/connections, the chat turn’s SSE) or from a labelled preview; nothing here is an execution, a progress or a receipt.'),
        h('p', { class: 'sh-note', 'data-inspect-listing': '' }, R ? 'Reading the companion’s listing…' : 'rive-bindings.js has not loaded: nothing to inspect.'),
        h('div', { class: 'tr-cards', 'data-inspect-cards': '' }),
        h('div', { class: 'sh-actions' }, h('button', { type: 'button', class: 'sh-btn', 'data-inspect-close': '' }, 'Close'))));
    if (!R) return;
    R.watchPage();
    Promise.all([
      fetcher(LISTING).then(async (r) => (r.status === 200 ? { status: 200, ...(await r.json()) } : { status: r.status, words: r.status === 404 ? 'GET /api/rive/assets answered 404: this companion does not serve the Rive components’ listing yet (src/companion/rive-assets.ts is not mounted), so only the T mark is listed.' : `GET /api/rive/assets answered ${r.status}.` })).catch(() => ({ status: 0, words: 'GET /api/rive/assets did not answer.' })),
      fetch(WORDS_PATH, { cache: 'no-store', credentials: 'omit' }).then((r) => (r.status === 200 ? r.json() : null)).catch(() => null),
    ]).then(([l, m]) => {
      listing = l;
      mark = m;
      const note = host.querySelector('[data-inspect-listing]');
      if (note) note.textContent = l.status === 200 ? `${l.words || ''} Runtime served by this companion: ${l.runtime ? 'yes (/vendor/rive/)' : 'no (@rive-app/canvas not installed)'}. ${m && m.words ? `T mark: ${m.words}` : ''}` : l.words;
      redraw();
      if (!timer) timer = setInterval(() => { if (hostEl && !hostEl.hidden) redraw(); }, 1500);
    });
  }

  /**
   * Redraws the cards from the handles as they are. A redraw never makes a handle twice (handleFor reuses made[key]) and never
   * loads a file again: a handle that settled on its words (a file that failed) stays on its words through every redraw, so a
   * binding event — or a runtime's load error — cannot feed a redraw that asks for the file again (H172's note). Redraws asked
   * for in one frame are one redraw.
   */
  function redraw() {
    const host = hostEl;
    if (!host) return;
    const cards = host.querySelector('[data-inspect-cards]');
    if (!cards) return;
    cards.replaceChildren();
    for (const c of components()) card(c.key, c, cards);
  }
  /** The redraw a binding event asks for: one per frame, however many events arrive in it. */
  let redrawAsked = false;
  function redrawSoon() {
    if (redrawAsked) return;
    redrawAsked = true;
    const go = () => { redrawAsked = false; if (hostEl && !hostEl.hidden) redraw(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go); else go();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const p = t.closest('[data-preview]');
    if (p && p.closest('[data-inspect-cards]')) {
      const [key, word] = p.getAttribute('data-preview').split(':');
      const handle = made[key];
      if (!handle) return;
      const R = window.TimmyRive;
      if (word === 'selected' || word === 'expanded') R.preview(handle, word, !handle.values[word]);
      else R.preview(handle, key.startsWith('connection') ? 'connection' : 'activity', word);
      redraw();
      return;
    }
    if (t.closest('[data-inspect-close]')) { close(); }
  });
  if (window.TimmyRive) window.TimmyRive.on(() => redrawSoon());

  // ── where the view lives ──
  let own = null;
  function close() {
    const s = shell();
    if (s && s.SCREENS && s.SCREENS.includes(SCREEN) && s.current() === SCREEN) { s.go('chat'); return; }
    if (location.hash === `#${SCREEN}`) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; } }
    if (own) own.hidden = true;
  }
  function showOwn() {
    if (!own) {
      own = h('section', { class: 'sh-screen tr-inspect-own', id: `screen-${SCREEN}`, 'data-screen': SCREEN, 'aria-label': 'Inspect animation', role: 'dialog', 'aria-modal': 'false' });
      document.body.append(own);
    }
    own.hidden = false;
    draw(own);
    const heading = own.querySelector('h2');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
  }
  function onHash() {
    if (location.hash === `#${SCREEN}`) showOwn(); else if (own) own.hidden = true;
  }
  function mountIt() {
    const s = shell();
    if (s && Array.isArray(s.SCREENS) && s.SCREENS.includes(SCREEN) && typeof s.mount === 'function') { try { s.mount(SCREEN, (host) => draw(host)); return; } catch (e) { /* the fragment path below */ } }
    window.addEventListener('hashchange', onHash);
    onHash();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountIt); else mountIt();
  window.timmyInspectAnimation = { draw, redraw, close, components, PREVIEW_LABEL, handles: () => ({ ...made }) };
})();
