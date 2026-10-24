// R11 round 5 (H174): window.TimmyRive — the companion page's Rive components and their runtime bindings. One module, a classic
// script (CSP script-src 'self'), loaded after shell.js; the Studio canvas bundle imports it too (companion/studio-canvas/src/
// rive-shape.js), so it is idempotent and reads nothing it is not given.
//
//   TimmyRive.component({ host, component, asset, artboard, stateMachine, role, label, binds, onTrigger })
//       → a handle: a real <button> (role 'button': the user-triggered welcome) or <div role="img" aria-label> holding the
//         <canvas> and the text fallback, with an HTML status label BESIDE it (aria-live="polite", the exact state word): the
//         canvas is never the only carrier of a state.
//   TimmyRive.load(canvas, assetPath, { artboard, stateMachine, label? })  → a handle (the lower-level call)
//   TimmyRive.set(handle, input, value, source)   → records { input, value, at, source } (the Inspect view's binding events) and
//         moves the runtime's input of that name when the .riv is loaded: a Number input takes the word's number (VOCAB), a
//         Bool its boolean, a Trigger is fired. Every set() also writes the word to the HTML label.
//   TimmyRive.trigger(handle, input, event)      → fires a Trigger ONLY for a trusted click / Enter / Space (never automatic).
//   TimmyRive.fromProviderState(id, word, source) / fromSse(event, data, source) / stopping(source)  → the feeds the owners'
//         code calls with the backend's own event (H170's providerStates words; H169's SSE event names).
//   TimmyRive.watchPage()                        → until they do: the vocabularies DERIVED from what the screens draw (a
//         MutationObserver on [data-provider][data-state] and #cx-turns li.cx-turn.is-*), each event labelled "derived from the
//         page's drawing of …" — never presented as the backend event itself.
//   TimmyRive.inspect()                          → every handle: the asset, what the RUNTIME reports (contents: artboards, state
//         machines, inputs with type and CURRENT value), the last binding events, the fallback words.
//   TimmyRive.preview(handle, input, value)      → moves the animation only, recorded with source 'PREVIEW' (the Inspect view's
//         labelled control): it writes no state anywhere else, shows no receipt, no progress.
//
// TRUTH: a missing .riv or runtime leaves the text fallback and the words GET /assets/mark.json gives (never an error, never a
// drawn stand-in that looks like the animation); prefers-reduced-motion → autoplay off, the runtime paused on its first frame
// (still drawn, the labels still readable). The runtime is @rive-app/canvas served by the companion at /vendor/rive/ (no CDN:
// enableRiveAssetCDN false, setWasmUrl to this origin).
(() => {
  'use strict';
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (W.TimmyRive && W.TimmyRive.VERSION) return;

  /** The five operational vocabularies as named inputs (the state machine's input names), and each word's number. */
  const VOCAB = Object.freeze({
    connection: Object.freeze(['disconnected', 'checking', 'connected', 'failed']),
    activity: Object.freeze(['idle', 'working', 'awaiting', 'stopping', 'stopped', 'failed']),
    selected: Object.freeze([false, true]),
    expanded: Object.freeze([false, true]),
    welcome: Object.freeze(['welcome']),
  });
  /** The word shown beside an activity state (the operator's words; 'awaiting' is "awaiting approval"). */
  const SHOWN = Object.freeze({ awaiting: 'awaiting approval' });
  const RUNTIME_PATH = '/vendor/rive/rive.js';
  const WASM_PATH = '/vendor/rive/rive.wasm';
  const WORDS_PATH = '/assets/mark.json';
  const LISTING_PATH = '/api/rive/assets';
  /** A file that neither loads nor fails within this long is said to have not loaded (the words stand). */
  const LOAD_PATIENCE_MS = 8000;
  const MAX_EVENTS = 40;
  const FALLBACK_WORDS = 'The animation’s file is not in this installation: its state is the word beside it.';

  const handles = [];
  let seq = 0;
  let runtimeState = 'unasked'; // unasked | loading | here | none
  let runtimeWaiters = [];
  let words = null; // { mark, runtime, words } from /assets/mark.json, or null
  let wordsAsked = null;
  const listeners = [];

  const still = () => { try { return W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const now = () => new Date().toISOString();
  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : String(v)); }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };
  const emit = (handle, ev) => { for (const fn of listeners) { try { fn(handle, ev); } catch (e) { /* a listener's own */ } } };

  /** The fetch the page gives (TimmyShell.fetch carries the launch token + session); plain fetch for the assets, which need none. */
  const plainFetch = (url) => (typeof fetch === 'function' ? fetch(url, { cache: 'no-store', credentials: 'omit' }) : Promise.reject(new Error('no fetch')));

  /** GET /assets/mark.json once: whether the companion serves the runtime, and its words for a page without the animation. */
  function askWords() {
    if (wordsAsked) return wordsAsked;
    wordsAsked = plainFetch(WORDS_PATH).then(async (r) => {
      const b = r.status === 200 ? await r.json().catch(() => null) : null;
      words = b && typeof b === 'object' ? { mark: b.mark === true, runtime: b.runtime === true, words: typeof b.words === 'string' ? b.words : FALLBACK_WORDS } : { mark: false, runtime: false, words: FALLBACK_WORDS };
      return words;
    }).catch(() => { words = { mark: false, runtime: false, words: FALLBACK_WORDS }; return words; });
    return wordsAsked;
  }

  let runtimeWhy = '';
  let listingAsked = null;
  /** GET /api/rive/assets (through the shell's fetch, which carries the launch token): whether any component has its .riv. */
  function anyRiv() {
    if (listingAsked) return listingAsked;
    const f = W.TimmyShell && typeof W.TimmyShell.fetch === 'function' ? W.TimmyShell.fetch.bind(W.TimmyShell) : (typeof companion !== 'undefined' && companion && companion.fetch ? companion.fetch : null);
    if (!f) { listingAsked = Promise.resolve(false); return listingAsked; }
    listingAsked = f(LISTING_PATH).then(async (r) => { const b = r.status === 200 ? await r.json().catch(() => null) : null; return Boolean(b && Array.isArray(b.components) && b.components.some((c) => c && c.riv)); }).catch(() => false);
    return listingAsked;
  }

  /** The runtime (window.rive), loaded once from this origin when the companion says it serves it; null when it does not. */
  function runtime() {
    if (W.rive && W.rive.Rive) { runtimeState = 'here'; return Promise.resolve(W.rive); }
    if (runtimeState === 'none') return Promise.resolve(null);
    return new Promise((resolve) => {
      runtimeWaiters.push(resolve);
      if (runtimeState === 'loading') return;
      runtimeState = 'loading';
      const settle = (rv) => { runtimeState = rv ? 'here' : 'none'; const ws = runtimeWaiters; runtimeWaiters = []; for (const w of ws) w(rv); };
      // the runtime is loaded only when there is a file for it to draw: the page's policy carries the WebAssembly keyword
      // only then (page.ts setPagePolicyWasm; rive-assets.ts), and a runtime without it would fail its compile and ask a CDN
      Promise.all([askWords(), anyRiv()]).then(([w, any]) => {
        if (!w.runtime || typeof document === 'undefined') { settle(null); return; }
        if (!w.mark && !any) { runtimeWhy = 'no .riv is in this installation, so the runtime is not loaded'; settle(null); return; }
        const s = document.createElement('script');
        s.src = RUNTIME_PATH;
        s.onload = () => { const rv = W.rive && W.rive.Rive ? W.rive : null; try { if (rv && rv.RuntimeLoader) rv.RuntimeLoader.setWasmUrl(WASM_PATH); } catch (e) { /* the runtime's own default would be a CDN: refused by the page's policy, so said in words */ } settle(rv); };
        s.onerror = () => settle(null);
        document.head.append(s);
      });
    });
  }

  /** The number a word has on its Number input, or null when the input takes something else. */
  function numberOf(input, value) {
    const v = VOCAB[input];
    if (!v) return typeof value === 'number' ? value : null;
    if (input === 'selected' || input === 'expanded') return null;
    const i = v.indexOf(value);
    return i < 0 ? null : i;
  }

  /** The label's word for a value. */
  const wordOf = (input, value) => (typeof value === 'boolean' ? (value ? input : `not ${input}`) : SHOWN[value] || String(value));

  /** What the runtime reports of a loaded file (contents, names, the inputs with their type and current value). */
  function report(handle) {
    const r = handle.rive;
    if (!r) return null;
    const typeName = (t) => (t === 56 ? 'Number' : t === 58 ? 'Trigger' : t === 59 ? 'Bool' : String(t));
    let contents = null;
    try { contents = r.contents || null; } catch (e) { contents = null; }
    const artboards = contents && Array.isArray(contents.artboards) ? contents.artboards.map((a) => ({ name: a.name, animations: a.animations || [], stateMachines: (a.stateMachines || []).map((m) => ({ name: m.name, inputs: (m.inputs || []).map((i) => ({ name: i.name, type: typeName(i.type) })) })) })) : [];
    let inputs = [];
    try { inputs = (handle.stateMachine ? r.stateMachineInputs(handle.stateMachine) || [] : []).map((i) => ({ name: i.name, type: typeName(i.type), value: i.type === 58 ? null : i.value })); } catch (e) { inputs = []; }
    let animationNames = [];
    let stateMachineNames = [];
    try { animationNames = r.animationNames || []; stateMachineNames = r.stateMachineNames || []; } catch (e) { /* not loaded */ }
    return { artboards, artboardNames: artboards.map((a) => a.name), stateMachineNames, animationNames, inputs };
  }

  /** The runtime's input of this name on the handle's state machine, or null. */
  function inputOf(handle, name) {
    if (!handle.rive || !handle.stateMachine) return null;
    try { return (handle.rive.stateMachineInputs(handle.stateMachine) || []).find((i) => i.name === name) || null; } catch (e) { return null; }
  }

  /** Moves the runtime's input (when loaded) and keeps the value for when it loads. Returns what happened, in a word. */
  function move(handle, input, value) {
    handle.values[input] = value;
    if (!handle.rive) return handle.state === 'loading' ? 'kept until the file loads' : 'the word only (no animation here)';
    const i = inputOf(handle, input);
    if (!i) return `no input named ${input} in ${handle.stateMachine || 'the file'}`;
    try {
      if (i.type === 58) { i.fire(); }
      else if (i.type === 59) { i.value = Boolean(value); }
      else { const n = numberOf(input, value); if (n === null) return `${input} is a Number input; ${JSON.stringify(value)} has no number`; i.value = n; }
      if (handle.still) { try { handle.rive.pause(); } catch (e) { /* paused already */ } }
      return 'moved';
    } catch (e) { return `the runtime refused: ${e && e.message ? e.message : e}`; }
  }

  function setLabel(handle, input, value) {
    if (!handle.label) return;
    if (input === 'selected' || input === 'expanded') { handle.label.dataset[input] = String(Boolean(value)); handle.label.textContent = handle.word + (handle.values.selected ? ' · selected' : '') + (handle.values.expanded ? ' · expanded' : ''); return; }
    if (input === 'welcome') { handle.label.textContent = `${handle.word} · welcome`; return; }
    handle.word = wordOf(input, value);
    handle.label.textContent = handle.word + (handle.values.selected ? ' · selected' : '') + (handle.values.expanded ? ' · expanded' : '');
    handle.label.dataset.state = String(value);
    if (handle.root) handle.root.dataset.state = String(value);
  }

  /** One binding event: recorded for the Inspect view, the label written, the runtime moved. */
  function set(handle, input, value, source) {
    if (!handle || typeof input !== 'string') return null;
    const did = move(handle, input, value);
    const ev = { input, value, at: now(), source: typeof source === 'string' && source ? source : 'unnamed', did };
    handle.events.push(ev);
    if (handle.events.length > MAX_EVENTS) handle.events.splice(0, handle.events.length - MAX_EVENTS);
    setLabel(handle, input, value);
    emit(handle, ev);
    return ev;
  }

  /** A Trigger fired only by the person: a trusted click, or Enter / Space on the component. Never automatic. */
  function trigger(handle, input, event) {
    const trusted = event && event.isTrusted === true && (event.type === 'click' || (event.type === 'keydown' && (event.key === 'Enter' || event.key === ' ')));
    if (!trusted) return null;
    return set(handle, input, input === 'welcome' ? 'welcome' : true, `user ${event.type}${event.key ? ` ${event.key === ' ' ? 'Space' : event.key}` : ''}`);
  }

  /**
   * Loads `assetPath` into `canvas` through the runtime; the handle's state is 'loading' → 'drawn' (the runtime drew it) or
   * 'words' (no runtime, no file, or the file refused: the text fallback and the words, never an error).
   */
  function load(canvas, assetPath, o = {}) {
    const handle = {
      id: `rive-${++seq}`, component: o.component || 'component', asset: assetPath, artboard: o.artboard || null, stateMachine: o.stateMachine || null,
      canvas, rive: null, state: 'loading', why: '', still: still(), values: {}, events: [], label: o.label || null, root: o.root || null, fallback: o.fallback || null,
      binds: Array.isArray(o.binds) ? o.binds.slice() : [], word: o.word || 'idle', sources: Array.isArray(o.sources) ? o.sources : [],
    };
    handles.push(handle);
    const toWords = (why) => {
      handle.state = 'words';
      handle.why = why;
      if (canvas) { delete canvas.dataset.loaded; canvas.dataset.riveState = 'words'; }
      if (handle.fallback) handle.fallback.hidden = false;
      if (handle.root) handle.root.dataset.rive = 'words';
      askWords().then((w) => { if (handle.note) handle.note.textContent = w.words; });
    };
    if (!canvas || typeof assetPath !== 'string' || !assetPath) { toWords('no canvas or no asset path'); return handle; }
    canvas.dataset.riveState = 'loading';
    runtime().then((rv) => {
      if (!rv) { toWords(runtimeWhy || 'the companion serves no Rive runtime'); return; }
      const patience = setTimeout(() => { if (handle.state === 'loading') toWords(`the file did not load within ${LOAD_PATIENCE_MS / 1000} s`); }, LOAD_PATIENCE_MS);
      try {
        const r = new rv.Rive({
          src: assetPath, canvas, autoplay: !handle.still, enableRiveAssetCDN: false,
          ...(handle.artboard ? { artboard: handle.artboard } : {}),
          ...(handle.stateMachine ? { stateMachines: handle.stateMachine } : {}),
          onLoad: () => {
            clearTimeout(patience);
            handle.rive = r;
            handle.state = 'drawn';
            try { r.resizeDrawingSurfaceToCanvas(); } catch (e) { /* drawn at its size */ }
            canvas.dataset.loaded = 'true';
            canvas.dataset.riveState = 'drawn';
            if (handle.fallback) handle.fallback.hidden = true;
            if (handle.root) handle.root.dataset.rive = 'drawn';
            // the values set while it loaded, applied now
            for (const [k, v] of Object.entries(handle.values)) if (k !== 'welcome') move(handle, k, v);
            if (handle.still) { try { r.pause(); } catch (e) { /* paused */ } }
            emit(handle, { input: null, value: null, at: now(), source: 'runtime', did: 'loaded' });
          },
          onLoadError: () => { clearTimeout(patience); toWords('the file did not load'); try { r.cleanup(); } catch (e) { /* gone */ } },
        });
      } catch (e) { clearTimeout(patience); toWords(`the runtime refused: ${e && e.message ? e.message : e}`); }
    });
    return handle;
  }

  /**
   * A component in the page: `host` (where it is drawn), `component` (its name), `asset` (/assets/rive/<component>/<file>.riv),
   * `artboard`, `stateMachine`, `role` ('button' for the user-triggered welcome, else 'img'), `label` (the aria label / the
   * heading words), `binds` (the vocabulary feeds it follows: 'connection:<provider>' or 'activity'), `onTrigger(handle, ev)`.
   */
  function component(o) {
    const host = o.host;
    const role = o.role === 'button' ? 'button' : 'img';
    const text = o.text || 'T';
    const canvas = h('canvas', { 'data-timmy-rive': o.component, 'aria-hidden': 'true' });
    const fallback = h('span', { class: 'tr-fallback', 'aria-hidden': 'true' }, text);
    const face = role === 'button'
      ? h('button', { type: 'button', class: 'tr-face', 'aria-label': o.label || o.component, 'data-rive-face': o.component }, canvas, fallback)
      : h('div', { class: 'tr-face', role: 'img', 'aria-label': o.label || o.component, tabindex: '0', 'data-rive-face': o.component }, canvas, fallback);
    const label = h('span', { class: 'tr-status sh-state', 'aria-live': 'polite', 'data-rive-status': o.component }, o.word || (o.binds && o.binds.some((b) => b.startsWith('connection')) ? 'disconnected' : 'idle'));
    const note = h('span', { class: 'tr-note sh-note', 'data-rive-note': o.component });
    const root = h('div', { class: `tr-component tr-${o.component}`, 'data-rive-component': o.component, 'data-rive': 'loading' }, face, h('span', { class: 'tr-words' }, o.heading ? h('span', { class: 'tr-heading' }, o.heading) : null, label, note));
    if (host) host.append(root);
    const handle = load(canvas, o.asset, { ...o, label, root, fallback, word: label.textContent });
    handle.note = note;
    handle.face = face;
    if (handle.state === 'words') askWords().then((w) => { note.textContent = w.words; });
    const fire = (ev) => { const did = trigger(handle, o.triggerInput || 'welcome', ev); if (did && typeof o.onTrigger === 'function') o.onTrigger(handle, did); if (did && ev.type === 'keydown') ev.preventDefault(); };
    if (role === 'button') { face.addEventListener('click', fire); }
    else face.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') fire(ev); });
    if (role === 'button') face.addEventListener('keydown', (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { /* a button's own click follows */ } });
    return handle;
  }

  /** Every handle bound to `bind` ('connection:<id>' or 'activity'). */
  const bound = (bind) => handles.filter((x) => x.binds.includes(bind));

  /** H170's providerStates word → the connection vocabulary. */
  function connectionWordOf(stateWord) {
    const s = String(stateWord || '');
    if (s === 'checked') return 'connected';
    if (s === 'pending') return 'checking';
    if (s === 'refused' || s === 'unreachable') return 'failed';
    return 'disconnected';
  }
  function fromProviderState(id, stateWord, source) {
    const word = connectionWordOf(stateWord);
    const src = source || `GET /api/connections: ${id} "${stateWord}"`;
    const out = [];
    for (const x of bound(`connection:${id}`)) out.push(set(x, 'connection', word, src));
    for (const x of bound('connection')) out.push(set(x, 'connection', word, src));
    return out;
  }
  /** H169's SSE event → the activity vocabulary (null when the event moves nothing: route, delta, tool ran, …). */
  function activityWordOf(event, data) {
    if (event === 'turn' || event === 'route' || event === 'delta') return 'working';
    if (event === 'tool') return data && data.status === 'asked' ? 'working' : data && data.status === 'failed' ? 'working' : 'working';
    if (event === 'needs-you') return 'awaiting';
    if (event === 'error') return 'failed';
    if (event === 'done') { const s = data && data.status; return s === 'cancelled' ? 'stopped' : s === 'failed' ? 'failed' : 'idle'; }
    return null;
  }
  function fromSse(event, data, source) {
    const word = activityWordOf(event, data);
    if (!word) return [];
    const src = source || `SSE ${event}${data && data.status ? ` (${data.status})` : ''}`;
    return bound('activity').map((x) => set(x, 'activity', word, src));
  }
  const stopping = (source) => bound('activity').map((x) => set(x, 'activity', 'stopping', source || 'POST /api/chat/stop'));

  /**
   * The vocabularies derived from what the screens draw, until their owners feed the events themselves: H170's cards carry
   * data-provider + data-state (the providerStates word from GET /api/connections); H171's turns are li.cx-turn.is-timmy
   * with is-streaming / is-answered / is-stopped / is-failed, a needs-you box as .cx-needs. Each event says it is derived.
   */
  let watching = null;
  function watchPage() {
    if (watching || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return watching;
    const seen = {};
    const look = () => {
      for (const card of document.querySelectorAll('[data-provider][data-state]')) {
        const id = card.getAttribute('data-provider');
        const st = card.getAttribute('data-state');
        if (seen[`c:${id}`] === st) continue;
        seen[`c:${id}`] = st;
        fromProviderState(id, st, `derived from the page's drawing of GET /api/connections: ${id} data-state="${st}"`);
      }
      const turns = document.querySelectorAll('#cx-turns li.cx-turn.is-timmy');
      const last = turns[turns.length - 1];
      let word = null;
      let why = '';
      if (last) {
        if (last.classList.contains('is-streaming')) { word = last.querySelector('.cx-needs') ? 'awaiting' : 'working'; why = word === 'awaiting' ? 'li.cx-turn.is-streaming with .cx-needs (needs-you)' : 'li.cx-turn.is-streaming'; }
        else if (last.classList.contains('is-stopped')) { word = 'stopped'; why = 'li.cx-turn.is-stopped'; }
        else if (last.classList.contains('is-failed')) { word = 'failed'; why = 'li.cx-turn.is-failed'; }
        else if (last.classList.contains('is-answered')) { word = 'idle'; why = 'li.cx-turn.is-answered (done)'; }
      }
      if (word && seen.activity !== `${word}:${last.dataset.own || ''}`) {
        seen.activity = `${word}:${last.dataset.own || ''}`;
        for (const x of bound('activity')) set(x, 'activity', word, `derived from the page's drawing of the turn: ${why}`);
      }
    };
    watching = new MutationObserver(() => { try { look(); } catch (e) { /* the next change */ } });
    watching.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'class'] });
    document.addEventListener('click', (ev) => { const b = ev.target && ev.target.closest && ev.target.closest('#cx-stop, [data-cx="stop"]'); if (b && ev.isTrusted) stopping("derived from the page's Stop button (POST /api/chat/stop)"); }, true);
    look();
    return watching;
  }

  /** What each component is now: for the Inspect view. Nothing here is a receipt or a progress number. */
  function inspect() {
    return handles.map((x) => ({
      id: x.id, component: x.component, asset: x.asset, artboard: x.artboard, stateMachine: x.stateMachine, state: x.state, why: x.why, still: x.still,
      word: x.word, values: { ...x.values }, binds: x.binds.slice(), events: x.events.slice(), runtime: report(x), sources: x.sources.slice(),
    }));
  }

  /** PREVIEW: moves the animation only (recorded with the source 'PREVIEW'); it writes no state anywhere, shows nothing else. */
  const preview = (handle, input, value) => set(handle, input, value, 'PREVIEW — not an execution, no progress, no receipt');

  W.TimmyRive = Object.freeze({
    VERSION: 'r11-r5', VOCAB, RUNTIME_PATH, WASM_PATH, FALLBACK_WORDS,
    component, load, set, trigger, preview, inspect, fromProviderState, fromSse, stopping, watchPage, connectionWordOf, activityWordOf,
    words: askWords, runtime, runtimeState: () => runtimeState, runtimeWhy: () => runtimeWhy, handles: () => handles.slice(), on: (fn) => { if (typeof fn !== 'function') return () => {}; listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    reducedMotion: still,
    /** For a page that unloads: the runtimes let go. */
    cleanup: () => { for (const x of handles) { try { if (x.rive) x.rive.cleanup(); } catch (e) { /* gone */ } } },
  });
  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => W.TimmyRive.cleanup());
})();
