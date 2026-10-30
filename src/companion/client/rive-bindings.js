// R11 round 5 (H174): window.TimmyRive — the companion page's Rive components and their runtime bindings. One module, a classic
// script (CSP script-src 'self'), loaded after shell.js; the Studio canvas bundle imports it too (companion/studio-canvas/src/
// rive-shape.js), so it is idempotent and reads nothing it is not given.
//
//   TimmyRive.component({ host, component, asset, artboard, stateMachine, role, label, binds, onTrigger })
//       → a handle: a real <button> (role 'button': the user-triggered welcome) or <div role="img" aria-label> holding the
//         <canvas> and the text fallback, with an HTML status label BESIDE it (aria-live="polite", the exact state word): the
//         canvas is never the only carrier of a state.
//   TimmyRive.mountConsole / mountProviderCard / mountActionButton (R11 round 6) → the PRODUCTION faces the screens mount. Since the
//         operator's item 4 (2026-10-24 19:18) a production console or card carries ONE thing — the state: the HTML state word as
//         its headline in every pose and the mark the state animates; its other runs read "" at every size; its aria-label is the
//         state word (+ the provider's name on a card); its status label is the live region (`words: 'spoken'` keeps it off the
//         screen while the face is drawn AND its headline reaches the 13-px floor — fitHeadline scales the headline up to it
//         within the artboard's room; where it cannot, the HTML word stays beside the face). The Inspect view's faces draw the
//         artboards as authored.
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
  /**
   * The operator's native asset (src/companion/assets/rive/timmy-ui/timmy-ui.riv; its CONTRACT in the README beside it): ONE state
   * machine `TimmyUI` on each of its three artboards (AgentConsole, ProviderCard, ActionButton), the inputs `State` Number
   * (0 Idle · 1 Working/Checking · 2 Approval · 3 Stopped · 4 Failed), `Hover` Bool, `Pressed` Bool, `ReducedMotion` Bool. This
   * page's vocabularies map onto it; a word with NO native pose is drawn as the nearest truthful one and said so: `connected`
   * has no success pose (none is authored, by design) → State 0 Idle, the HTML label alone says "connected"; `stopping` (the
   * turn still runs while Stop is asked) → State 1 Working until the backend says cancelled (→ 3). `selected` → Hover (the
   * native outline stands for the selection); `expanded` → no native input (HTML only); `welcome` → Pressed (a press, down
   * then up). An asset whose state machine is not TimmyUI keeps the input names as they are (the drafted sources name theirs
   * after the vocabularies).
   */
  const TIMMY_UI = Object.freeze({
    stateMachine: 'TimmyUI',
    inputs: Object.freeze({
      connection: { name: 'State', values: { disconnected: 0, checking: 1, connected: 0, failed: 4 }, notes: { connected: 'no success pose is authored: State stays 0 Idle; the label says connected' } },
      activity: { name: 'State', values: { idle: 0, working: 1, awaiting: 2, stopping: 1, stopped: 3, failed: 4 }, notes: { stopping: 'no stopping pose: State 1 Working until the backend says cancelled (3)' } },
      selected: { name: 'Hover' },
      expanded: null,
      welcome: { name: 'Pressed', press: true },
      hover: { name: 'Hover' },
      pressed: { name: 'Pressed' },
    }),
  });
  /** The native input and value a vocabulary word maps to on this handle, or null when the asset has none for it. */
  function nativeOf(handle, input, value) {
    if (handle.stateMachine === TIMMY_UI.stateMachine) {
      const m = TIMMY_UI.inputs[input];
      if (m === null) return null;
      if (!m) return { name: input, value };
      if (m.values) { const n = m.values[value]; return n === undefined ? null : { name: m.name, value: n, note: m.notes && m.notes[value] ? m.notes[value] : '' }; }
      if (m.press) return { name: m.name, value: true, press: true };
      return { name: m.name, value: Boolean(value) };
    }
    const n = numberOf(input, value);
    return { name: input, value: typeof value === 'boolean' ? value : n === null ? value : n };
  }

  /** The word shown beside an activity state (the operator's words; 'awaiting' is "awaiting approval"). */
  const SHOWN = Object.freeze({ awaiting: 'awaiting approval' });
  /**
   * The text runs the native asset bakes into its faces (a run's name is its baked text: create-controls.py) and what a face
   * in this product says in them, so a live face never reads "PREVIEW" and a preview never reads "LIVE" (the operator's rule).
   * The runtime sets a run by name (artboard.textRun(name)); the ProviderCard's five same-named subtitle runs
   * ('OpenRouter  ·  Ollama  ·  Cloudflare', one per state group) it cannot tell apart, so that one is left as baked and the
   * README names it for the source.
   */
  const RUNS = Object.freeze({
    // v1 (the round-5 build): the baked runs the runtime overwrites, and the pill it scales away
    caption: 'PREVIEW  /  NOT A LIVE JOB',   // AgentConsole, ProviderCard
    inspect: 'Inspect interaction',           // AgentConsole, ProviderCard: the baked face button, meaningless here → ''
    actionIdle: 'Connect provider',           // ActionButton: its Idle label → the button's own label
    provider: 'OpenRouter  ·  Ollama  ·  Cloudflare', // ProviderCard ×5 under one name: not addressable (left as baked)
    pill: 'Primary action',                   // AgentConsole, ProviderCard: the amber pill under "Inspect interaction" (a Shape; the listener's hit area)
    // v2 (RIVE CONTRACT v2, CONTRACT.json): one name each, the page's words; the per-pose runs are Headline<pose> / Line<pose>
    v2: Object.freeze({ caption: 'Caption', tag: 'Tag', title: 'Title', providerName: 'ProviderName', providerState: 'ProviderState', providerDetail: 'ProviderDetail', headline: 'Headline', line: 'Line' }),
  });
  /** The state poses, as the artboards name their per-pose runs (create-controls.py STATES: Headline{pose}, the console's Line{pose}). */
  const POSES = Object.freeze(['Idle', 'Working', 'Approval', 'Stopped', 'Failed']);
  /**
   * What a PRODUCTION face carries (the operator's order of 2026-10-24 19:18, item 4; the lead's ruling of 19:24): ONE thing — the
   * state. A face a screen mounts through the mount API (mountConsole / mountProviderCard: handle.mounted) draws the HTML state word
   * as its headline in EVERY pose (the identical string: "checked", "awaiting approval" — never a second vocabulary, never a
   * capitalised twin) and the mark the state animates; its small runs — Title, Tag, Caption, and on a card ProviderName /
   * ProviderState / ProviderDetail, on the console the Line — read "" at every size, so no word is drawn twice (the HTML beside the
   * face keeps the accessible semantics: role=img, aria-label = the state word (+ the provider's name on a card), the live region).
   * The Inspect view's faces and the Studio's shape are not mounts: they draw the artboard as authored (the place to read a face;
   * the shape's AS SAVED caption is a truth marker). The ActionButton is untouched: its Caption is its own label.
   */
  const ONE_THING = 'a production face carries one thing — the state: its headline in every pose is the HTML state word (the same string), the mark animates by state; Title / Tag / Caption (a card’s ProviderName / ProviderState / ProviderDetail, the console’s Line) read "" at every size; the Inspect view’s faces keep theirs';
  const isProduction = (handle) => Boolean(handle.mounted);
  /**
   * LEGIBILITY (the lead's ruling of 22:12 on item 4; DESIGN.md B11 D2's floor): the one word a production face draws must be
   * READABLE where it is drawn — 13 CSS px at least. At mount and on every resize the drawn size of the headline is computed
   * (19 px × faceWidth / 400 on a card; 28 px × faceHeight / 380 on the console) and, where the artboard's room allows, the
   * headline's Text node is scaled up to the floor (artboard.node('Headline<pose>'), the way v1's pill was scaled: a runtime
   * transform, no rebuild), capped so the word stays inside the face — to the right of its origin by the word's estimated width,
   * below it by one line — and never shrunk. Where the floor cannot be reached (the Chat band's 40-px-tall face; a card too narrow
   * for its word) `words: 'spoken'` is NOT honoured: the HTML status stays visible beside the face (data-words reflects the
   * EFFECTIVE mode; inspect().wordsWhy says why), so no face ever shows a 3–7-px word as its only carrier.
   */
  const WORD_FLOOR = 13;
  /** The headline Text of each production artboard (create-controls.py): its authored size, its origin (top-left), the room it may grow into — artboard px. */
  const HEADLINE = Object.freeze({
    ProviderCard: { px: 19, base: 400, by: 'width', x: 24, y: 150, right: 300, bottom: 250 },   // the mark's ring begins at x 306; the artboard ends at y 260
    AgentConsole: { px: 28, base: 380, by: 'height', x: 28, y: 92, right: 612, bottom: 186 },  // the mark's ring begins at y 192
  });
  /** A conservative average advance per character of Outfit 600 (em) — the real width is narrower, so the cap errs inside the face. */
  const EM_ADVANCE = 0.6;
  const LINE_HEIGHT = 1.25;
  const round1 = (n) => Math.round(n * 10) / 10;
  const CAPTION = Object.freeze({
    preview: 'PREVIEW  /  NOT A LIVE JOB',
    activity: 'LIVE  /  THE TURN’S EVENTS',
    connection: 'LIVE  /  GET /api/connections',
    // the Control Room's run faces (bound 'job:<run>'): fed by the run's own record, read while it runs, then its end
    job: 'LIVE  /  THE RUN’S JOB',
    jobEnded: 'ENDED  /  THE RUN’S RECORD',
  });
  /** The provider's own words on a card (the id → its name), unless the page gave them (mountProviderCard's providerName). */
  const PROVIDER_NAMES = Object.freeze({ openrouter: 'OpenRouter', 'ollama-local': 'Ollama · local', 'ollama-cloud': 'Ollama · cloud', cloudflare: 'Cloudflare' });
  const providerNameOf = (id) => PROVIDER_NAMES[id] || String(id || '');
  /** The caption a face should carry now: the last state event's source decides (a preview says PREVIEW, a feed says LIVE). */
  function captionOf(handle) {
    if (!/^(AgentConsole|ProviderCard)/.test(handle.artboard || '')) return null;
    if (handle.stateSource === 'preview') return CAPTION.preview;
    if (handle.binds.some((b) => b.startsWith('job:'))) return handle.stateSource === 'fed' ? (handle.jobEnded ? CAPTION.jobEnded : CAPTION.job) : CAPTION.preview;
    if (handle.stateSource === 'fed') return handle.binds.some((b) => b.startsWith('connection')) ? CAPTION.connection : CAPTION.activity;
    if (handle.caption) return handle.caption;
    return handle.binds.some((b) => b.startsWith('connection')) ? CAPTION.connection : handle.binds.includes('activity') ? CAPTION.activity : CAPTION.preview;
  }
  /** The identity words a console's Tag carries: the turn the feed named (and the project / session the mount was given). */
  function tagOf(handle) {
    const id = handle.identity || {};
    const parts = [];
    if (id.turn) parts.push(`turn ${id.turn}`);
    if (id.project) parts.push(`project ${id.project}`);
    else if (id.session) parts.push(`session ${id.session}`);
    return parts.length ? parts.join(' · ') : null;
  }
  /**
   * Writes the runs on a drawn handle and records what each reads back (handle.runs, for the Inspect view and the tests). The
   * file's contract is read from the artboard itself: a `Caption` run = v2 (CONTRACT.json; the words go to their named runs); none
   * = the round-5 v1 build, whose baked PREVIEW caption and "Inspect interaction" pill are overwritten / scaled away here.
   */
  function applyRuns(handle) {
    const r = handle.rive;
    if (!r || !r.artboard) return;
    const put = (name, value) => {
      let run = null;
      try { run = r.artboard.textRun(name) || null; } catch (e) { run = null; }
      if (!run) return { name, set: value, reads: undefined, absent: true };
      try { if (value !== null && run.text !== value) run.text = value; } catch (e) { /* stays baked */ }
      let reads;
      try { reads = run.text; } catch (e) { reads = undefined; }
      return { name, set: value, reads };
    };
    const has = (name) => { try { return Boolean(r.artboard.textRun(name)); } catch (e) { return false; } };
    const runs = {};
    const v2 = has(RUNS.v2.caption);
    handle.contract = v2 ? 2 : 1;
    const art = handle.artboard || '';
    if (v2) {
      if (/^(AgentConsole|ProviderCard)/.test(art)) {
        const card = /^ProviderCard/.test(art);
        if (isProduction(handle)) {
          // item 4 (2026-10-24 19:18): ONE thing — the state. The HTML state word is the headline of every pose (the same string the
          // label beside the face reads, so the one word is never drawn in two spellings); every other run reads "" at every size
          const word = labelWord(handle);
          runs.title = put(RUNS.v2.title, '');
          runs.tag = put(RUNS.v2.tag, '');
          runs.caption = put(RUNS.v2.caption, '');
          if (card) { runs.providerName = put(RUNS.v2.providerName, ''); runs.providerState = put(RUNS.v2.providerState, ''); runs.providerDetail = put(RUNS.v2.providerDetail, ''); }
          const poses = {};
          for (const pose of POSES) poses[pose] = put(`${RUNS.v2.headline}${pose}`, word).reads;
          runs.headline = { name: `${RUNS.v2.headline}{${POSES.join('|')}}`, set: word, reads: poses.Idle, poses, note: 'the HTML state word, in every pose (item 4)' };
          if (!card) { const lines = {}; for (const pose of POSES) lines[pose] = put(`${RUNS.v2.line}${pose}`, '').reads; runs.line = { name: `${RUNS.v2.line}{${POSES.join('|')}}`, set: '', reads: lines.Idle, poses: lines }; }
          // the word's drawn size: the headline fitted to the floor (the room allowing), the words mode placed by the outcome
          const fit = fitHeadline(handle);
          runs.production = { headline: word, hidden: [RUNS.v2.title, RUNS.v2.tag, RUNS.v2.caption, ...(card ? [RUNS.v2.providerName, RUNS.v2.providerState, RUNS.v2.providerDetail] : [RUNS.v2.line])], faceWidth: typeof handle.faceWidth === 'number' ? handle.faceWidth : null, fit: fit ? { ...fit } : null, words: handle.words || null, note: ONE_THING };
        } else {
          // the Inspect view's faces (the preview artboards) and a Canvas shape: the artboard as authored, the page's words in the
          // named runs — a preview artboard keeps its baked PREVIEW caption; another carries the source of its state (AS SAVED, LIVE)
          runs.caption = put(RUNS.v2.caption, /Preview$/.test(art) ? null : captionOf(handle));
          runs.tag = put(RUNS.v2.tag, tagOf(handle));
          runs.title = put(RUNS.v2.title, card ? 'TIMMY  /  PROVIDERS' : 'TIMMY  /  AGENT CONSOLE');
          if (card) {
            const isBound = handle.binds.some((b) => b.startsWith('connection'));
            runs.providerName = put(RUNS.v2.providerName, cardName(handle));
            runs.providerState = put(RUNS.v2.providerState, isBound ? labelWord(handle) : null);
            runs.providerDetail = put(RUNS.v2.providerDetail, typeof handle.providerDetail === 'string' ? handle.providerDetail : null);
          }
        }
      } else if (/^ActionButton/.test(art)) {
        runs.caption = put(RUNS.v2.caption, /Preview$/.test(art) ? null : (typeof handle.faceLabel === 'string' ? handle.faceLabel : (handle.word || '')));
      }
    } else if (art === 'AgentConsole' || art === 'ProviderCard') {
      runs.caption = put(RUNS.caption, captionOf(handle));
      runs.inspect = put(RUNS.inspect, '');
      // the baked amber pill under that text (the Shape "Primary action", the listener's hit area) is a control that means
      // nothing here: scaled to nothing through the runtime's node API (the artboard's node of that name; no opacity there)
      let pill = null;
      try { pill = r.artboard.node(RUNS.pill) || null; } catch (e) { pill = null; }
      if (pill) { try { pill.scaleX = 0; pill.scaleY = 0; } catch (e) { pill = null; } }
      runs.pill = { name: RUNS.pill, hidden: Boolean(pill), note: pill ? 'scaled to 0 by the runtime (artboard.node)' : 'not reachable through the runtime: drawn as baked' };
      if (art === 'ProviderCard') runs.provider = { name: RUNS.provider, set: null, reads: put(RUNS.provider, null).reads, note: 'five runs share this name (one per state group): the runtime addresses one; left as baked — the v2 source names them apart' };
    } else if (art === 'ActionButton') {
      runs.actionIdle = put(RUNS.actionIdle, typeof handle.faceLabel === 'string' ? handle.faceLabel : (handle.word || ''));
    }
    handle.runs = runs;
  }
  /** The State input, cached per drawn handle (the wrapper stays valid while the instance lives). */
  function stateInput(handle) {
    if (handle.stateInputCached) return handle.stateInputCached;
    if (!handle.rive) return null;
    handle.stateInputCached = inputOf(handle, 'State');
    return handle.stateInputCached;
  }
  /**
   * Every frame: the asset bakes a click listener ("Inspect click": the hit area → State = 1) that would put a live face in
   * Working/Checking without any backend event. A State the feed did not set is put back to the fed value before the frame
   * draws (the face's canvas also takes no pointer events: rive-components.css). Counted on handle.restored.
   */
  function guardState(handle) {
    const si = stateInput(handle);
    if (!si || typeof handle.fedState !== 'number') return;
    try { if (si.value !== handle.fedState) { si.value = handle.fedState; handle.restored = (handle.restored || 0) + 1; } } catch (e) { /* the input is gone */ }
  }
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

  /**
   * The T mark's facts once: from the listing (GET /api/rive/assets carries `mark` since R11 round 7, on the companion and the
   * Studio alike), else GET /assets/mark.json (the companion's; an older server). The Studio serves no /assets/mark.json: asking
   * it first was the 404 after every placeRive (traced in studio-rive-shape-browser), so it is asked only when no listing answers.
   */
  function askWords() {
    if (wordsAsked) return wordsAsked;
    const read = (b) => ({ mark: b.mark === true, runtime: b.runtime === true, words: typeof b.words === 'string' ? b.words : FALLBACK_WORDS });
    const none = { mark: false, runtime: false, words: FALLBACK_WORDS };
    wordsAsked = listing().then((l) => {
      if (l.answered && l.mark) { words = { mark: l.mark.riv === true, runtime: l.runtime, words: typeof l.mark.words === 'string' ? l.mark.words : FALLBACK_WORDS }; return words; }
      if (l.answered) { words = { mark: false, runtime: l.runtime, words: FALLBACK_WORDS }; return words; }
      return plainFetch(WORDS_PATH).then(async (r) => {
        const b = r.status === 200 ? await r.json().catch(() => null) : null;
        if (!(b && typeof b === 'object')) { wordsAsked = null; return none; } // (nothing answered: asked again next time)
        words = read(b);
        return words;
      }).catch(() => { wordsAsked = null; return none; });
    });
    return wordsAsked;
  }

  let runtimeWhy = '';
  let listingAsked = null;
  /** Whether the last ask of the listing went unanswered (no session yet): the faces that went to words then are asked again. */
  let listingUnanswered = false;
  const UNANSWERED_WHY = 'the components’ listing has not answered yet (the page has no session yet, or the server did not reply): asked again at the next mount or when the session arrives';
  let listingInfo = null; // the served native file's facts from the listing (contract, artboards, previewArtboards, runs)
  /**
   * GET /api/rive/assets (through the shell's fetch, which carries the launch token, on the companion; plain on the Studio, whose
   * listing is open): whether any component has its .riv, and whether that server serves the runtime (the Studio has no
   * /assets/mark.json: its answer is the listing's). { any: false, runtime: false } when nothing answers.
   */
  function listing() {
    if (listingAsked) return listingAsked;
    const f = W.TimmyShell && typeof W.TimmyShell.fetch === 'function' ? W.TimmyShell.fetch.bind(W.TimmyShell) : (typeof companion !== 'undefined' && companion && companion.fetch ? companion.fetch : plainFetch);
    // (R11 round 7, the blocker on the merged head: a listing asked BEFORE the page's session exists gets the shell's 401
    // { needs: 'session' } — that answer is never kept; the next ask, at the next mount or when the session arrives, goes out)
    const unanswered = { answered: false, any: false, runtime: false, mark: null };
    listingAsked = f(LISTING_PATH).then(async (r) => {
      const b = r.status === 200 ? await r.json().catch(() => null) : null;
      if (!b || b.ok !== true) { listingAsked = null; return unanswered; }
      const native = Array.isArray(b.components) ? b.components.find((c) => c && c.component === 'timmy-ui') : null;
      const meta = native && native.meta && typeof native.meta === 'object' ? native.meta : {};
      // what the SERVED native file is (CONTRACT.json beside it, read by the server as meta.served — the source's rive.yaml may be
      // a contract ahead of the compiled file): the contract, its artboards, its preview artboards
      const served = meta.served && typeof meta.served === 'object' ? meta.served : { contract: 1, artboards: ['AgentConsole', 'ProviderCard', 'ActionButton'], previewArtboards: [] };
      listingInfo = { contract: Number(served.contract) || 1, artboards: Array.isArray(served.artboards) ? served.artboards : [], previewArtboards: Array.isArray(served.previewArtboards) ? served.previewArtboards : [], sourceContract: Number(meta.contract) || 1, runs: meta.runs && typeof meta.runs === 'object' ? meta.runs : {} };
      return { answered: true, any: Boolean(Array.isArray(b.components) && b.components.some((c) => c && c.riv)), runtime: b.runtime === true, mark: b.mark && typeof b.mark === 'object' ? b.mark : null };
    }).catch(() => { listingAsked = null; return unanswered; });
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
      Promise.all([askWords(), listing()]).then(([w, l]) => {
        if (typeof document === 'undefined') { runtimeWhy = 'no document'; settle(null); return; }
        if (!l.answered && !w.mark) {
          // the listing did not answer (the page has no session yet, or the server did not reply) and the mark alone gives no
          // file: nothing is loaded NOW, nothing is concluded — the next mount, or the session's arrival, asks again
          listingUnanswered = true;
          runtimeWhy = UNANSWERED_WHY;
          const ws = runtimeWaiters; runtimeWaiters = []; runtimeState = '';
          for (const x of ws) x(null);
          return;
        }
        listingUnanswered = false;
        if (!w.runtime && !l.runtime) { runtimeWhy = 'this server serves no Rive runtime'; settle(null); return; }
        if (!w.mark && !l.any) { runtimeWhy = 'no .riv is in this installation, so the runtime is not loaded'; settle(null); return; }
        const s = document.createElement('script');
        s.src = RUNTIME_PATH;
        s.onload = () => { const rv = W.rive && W.rive.Rive ? W.rive : null; try { if (rv && rv.RuntimeLoader) rv.RuntimeLoader.setWasmUrl(WASM_PATH); } catch (e) { /* the runtime's own default would be a CDN: refused by the page's policy, so said in words */ } settle(rv); };
        s.onerror = () => settle(null);
        document.head.append(s);
      });
    });
  }

  /**
   * What a component says beside its text fallback when its file is not drawn: the T mark's words are the companion's
   * (GET /assets/mark.json); every other component names ITS OWN file (the mark's words never stand in for another's).
   */
  function absentWords(handle) {
    const file = typeof handle.asset === 'string' ? handle.asset.slice(handle.asset.lastIndexOf('/') + 1) : '';
    // a face waiting on the listing (no session yet) says so — never "not in this installation", which nothing has said
    if (handle.retryable) return Promise.resolve(`${file || 'the file'} is not drawn yet: ${UNANSWERED_WHY}. The state is the word beside it.`);
    if (!file || file === 'timmy-mark.riv') return askWords().then((w) => w.words);
    return Promise.resolve(`${file} is not in this installation (its editable source is; the .riv is compiled by the Rive tooling): the state is the word beside it.`);
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
  const typeName = (t) => (t === 56 ? 'Number' : t === 58 ? 'Trigger' : t === 59 ? 'Bool' : String(t));
  /** What the file holds (artboards, state machines, animations): read from the runtime once per drawn handle — it never changes. */
  function fileReport(handle) {
    if (handle.fileReport) return handle.fileReport;
    const r = handle.rive;
    let contents = null;
    try { contents = r.contents || null; } catch (e) { contents = null; }
    const artboards = contents && Array.isArray(contents.artboards) ? contents.artboards.map((a) => ({ name: a.name, animations: a.animations || [], stateMachines: (a.stateMachines || []).map((m) => ({ name: m.name, inputs: (m.inputs || []).map((i) => ({ name: i.name, type: typeName(i.type) })) })) })) : [];
    let animationNames = [];
    let stateMachineNames = [];
    try { animationNames = r.animationNames || []; stateMachineNames = r.stateMachineNames || []; } catch (e) { /* not loaded */ }
    const out = { artboards, artboardNames: artboards.map((a) => a.name), stateMachineNames, animationNames };
    if (handle.state === 'drawn' && contents) handle.fileReport = out; // cached once the file is in (a redraw per event must not re-read it)
    return out;
  }
  /** The runtime's report for the Inspect view: the file's contents (cached) and the inputs' current values (read now). */
  function report(handle) {
    const r = handle.rive;
    if (!r) return null;
    let inputs = [];
    try { inputs = (handle.stateMachine ? r.stateMachineInputs(handle.stateMachine) || [] : []).map((i) => ({ name: i.name, type: typeName(i.type), value: i.type === 58 ? null : i.value })); } catch (e) { inputs = []; }
    return { ...fileReport(handle), inputs };
  }

  /** The runtime's input of this name on the handle's state machine, or null. */
  function inputOf(handle, name) {
    if (!handle.rive || !handle.stateMachine) return null;
    try { return (handle.rive.stateMachineInputs(handle.stateMachine) || []).find((i) => i.name === name) || null; } catch (e) { return null; }
  }

  /**
   * Moves the runtime's input (when loaded) and keeps the value for when it loads. Returns what happened, in words, and the
   * native input and value it set (handle.lastNative) for the event record.
   */
  function move(handle, input, value) {
    handle.values[input] = value;
    const native = nativeOf(handle, input, value);
    handle.lastNative = native ? { input: native.name, value: native.value, note: native.note || '' } : null;
    if (!handle.rive) return handle.state === 'loading' ? 'kept until the file loads' : 'the word only (no animation here)';
    if (!native) return `${input}: no native input on ${handle.stateMachine || 'the file'} (the HTML label carries it)`;
    const i = inputOf(handle, native.name);
    if (!i) return `no input named ${native.name} in ${handle.stateMachine || 'the file'}`;
    try {
      if (i.type === 58) { i.fire(); }
      else if (i.type === 59) {
        i.value = Boolean(native.value);
        // a press: down now, up on the next frame (the native Pressed wash plays its release)
        if (native.press) requestAnimationFrame(() => { try { if (handle.rive) i.value = false; } catch (e) { /* released */ } });
      } else { if (typeof native.value !== 'number') return `${native.name} is a Number input; ${JSON.stringify(value)} has no number`; i.value = native.value; if (native.name === 'State') handle.fedState = native.value; }
      // reduced motion without a native ReducedMotion input: the pose shown, the runtime paused (one advance draws it)
      if (handle.still && !handle.nativeReduced) { try { handle.rive.pause(); } catch (e) { /* paused */ } }
      return native.note ? `moved (${native.note})` : 'moved';
    } catch (e) { return `the runtime refused: ${e && e.message ? e.message : e}`; }
  }

  /** The word the label shows: the OBSERVED word the feed gave (H170's "checked", the probe's own word — R86: one word per card, never
   * the vocabulary's beside it), else the vocabulary word. */
  const labelWord = (handle) => (typeof handle.shown === 'string' && handle.shown ? handle.shown : handle.word);
  /** A card's provider id: the mount's, else the one its bind names ('connection:<id>' — the Inspect view's and a shape's cards). */
  const providerIdOf = (handle) => handle.providerId || (handle.binds.find((b) => b.startsWith('connection:')) || '').slice('connection:'.length) || null;
  /** The provider's name on a card: the screen's (mountProviderCard's providerName / setProvider), else the id's own words. */
  const cardName = (handle) => (typeof handle.providerName === 'string' && handle.providerName ? handle.providerName : providerNameOf(providerIdOf(handle)));
  /**
   * The accessible name of a production face (role=img; item 4): the state word — the one word the face draws as its headline —
   * and, on a card, the provider's name after it (the face draws no other words; the card's name is what tells the cards apart).
   */
  function faceName(handle) {
    const word = labelWord(handle);
    if (/^ProviderCard/.test(handle.artboardBase || handle.artboard || '')) { const name = cardName(handle); return name ? `${word} · ${name}` : word; }
    return word;
  }
  /** Writes that name on a mounted role=img face (a mounted ActionButton keeps its own: a button's name is its action). */
  function nameFace(handle) {
    if (!isProduction(handle) || !handle.face || handle.face.getAttribute('role') !== 'img') return;
    const name = faceName(handle);
    if (handle.face.getAttribute('aria-label') !== name) handle.face.setAttribute('aria-label', name);
  }
  /**
   * The EFFECTIVE words mode of a mount: 'spoken' (the HTML status off the screen, in the accessibility tree) is honoured only while
   * the face is drawn AND its headline reaches the floor; else 'beside' — the status visible beside the face. data-words on the root
   * is the effective mode (rive-components.css keys on it); data-words-asked the screen's ask; handle.wordsWhy says why.
   */
  function placeWords(handle) {
    if (!isProduction(handle)) return;
    const asked = handle.wordsAsked || 'beside';
    const hl = handle.headline;
    let effective = 'beside';
    let why;
    if (asked !== 'spoken') why = 'the HTML word beside the face, as the screen asked';
    else if (handle.state !== 'drawn') why = 'the face is not drawn: the HTML word is the state';
    else if (!hl) why = 'the face is not measured yet: the HTML word stays beside it';
    else if (hl.reached) { effective = 'spoken'; why = `the face draws the word at ${hl.px} px (the floor is ${WORD_FLOOR} px${hl.scale > 1 ? `; the headline scaled ×${hl.scale} within the artboard's room` : ''}): the HTML word is spoken, not shown`; }
    else why = `the face draws the word at ${hl.px} px — under the ${WORD_FLOOR}-px floor (the artboard's room allows ×${hl.scale} of the ${hl.authored}-px headline on this ${hl.faceWidth}×${hl.faceHeight} face): the HTML word stays beside the face`;
    handle.words = effective;
    handle.wordsWhy = why;
    if (handle.root) { handle.root.dataset.words = effective; handle.root.dataset.wordsAsked = asked; }
  }
  /**
   * Fits a production face's headline to the floor (the ruling above): measures the face, scales every pose's Headline node up to
   * the floor within the artboard's room, records handle.headline { floor, authored, faceWidth, faceHeight, drawn, scale, px,
   * reached, room, nodes, word } and places the words. Null when there is nothing to fit (not a mount, not drawn, no size yet).
   */
  function fitHeadline(handle) {
    if (!isProduction(handle)) return null;
    const spec = HEADLINE[handle.artboardBase || handle.artboard || ''];
    const r = handle.rive;
    // the face's size as the ResizeObserver measured it (fitWhenShown), read from layout only until it has: reading
    // clientWidth / clientHeight on every event forced a layout per event, ~12 per burst batch (the R12 failure diagnosis)
    const known = handle.faceWidth > 0 && handle.faceHeight > 0;
    const faceW = known ? handle.faceWidth : handle.face ? handle.face.clientWidth : 0;
    const faceH = known ? handle.faceHeight : handle.face ? handle.face.clientHeight : 0;
    if (!known && faceW > 0 && faceH > 0) { handle.faceWidth = faceW; handle.faceHeight = faceH; }
    if (!spec || !r || !r.artboard || handle.state !== 'drawn' || !(faceW > 0 && faceH > 0)) { placeWords(handle); return null; }
    // the same word on a face of the same size: the headline is already fitted (its nodes keep their scale)
    const prior = handle.headline;
    if (prior && prior.nodes > 0 && prior.word === String(labelWord(handle) || '') && prior.faceWidth === faceW && prior.faceHeight === faceH) { placeWords(handle); return prior; }
    const faceScale = (spec.by === 'width' ? faceW : faceH) / spec.base;
    const drawn = spec.px * faceScale;                                 // the headline's CSS px as authored, at this face's size
    const word = String(labelWord(handle) || '');
    const width = Math.max(1, word.length) * EM_ADVANCE * spec.px;     // the word's estimated width at scale 1 (artboard px)
    const roomW = (spec.right - spec.x) / width;
    const roomH = (spec.bottom - spec.y) / (spec.px * LINE_HEIGHT);
    const needed = drawn >= WORD_FLOOR ? 1 : WORD_FLOOR / drawn;
    const scale = Math.max(1, Math.min(needed, roomW, roomH));
    const px = drawn * scale;
    let nodes = 0;
    for (const pose of POSES) {
      let n = null;
      try { n = r.artboard.node(`${RUNS.v2.headline}${pose}`) || null; } catch (e) { n = null; }
      if (!n) continue;
      try { if (n.scaleX !== scale) n.scaleX = scale; if (n.scaleY !== scale) n.scaleY = scale; nodes += 1; } catch (e) { /* the pose stands at its authored size */ }
    }
    handle.headline = { floor: WORD_FLOOR, authored: spec.px, faceWidth: faceW, faceHeight: faceH, drawn: round1(drawn), scale: Math.round(scale * 1000) / 1000, px: round1(px), reached: nodes > 0 && px >= WORD_FLOOR - 0.01, room: { width: round1(roomW), height: round1(roomH) }, nodes, word };
    placeWords(handle);
    return handle.headline;
  }
  function setLabel(handle, input, value, shown) {
    if (!handle.label) return;
    if (input === 'selected' || input === 'expanded') { handle.label.dataset[input] = String(Boolean(value)); handle.label.textContent = labelWord(handle) + (handle.values.selected ? ' · selected' : '') + (handle.values.expanded ? ' · expanded' : ''); return; }
    if (input === 'welcome') { handle.label.textContent = `${labelWord(handle)} · welcome`; return; }
    handle.word = wordOf(input, value);
    handle.shown = typeof shown === 'string' && shown.trim() ? shown.trim() : null;
    handle.label.textContent = labelWord(handle) + (handle.values.selected ? ' · selected' : '') + (handle.values.expanded ? ' · expanded' : '');
    handle.label.dataset.state = String(value);
    if (handle.shown && handle.shown !== handle.word) handle.label.dataset.observed = handle.shown; else delete handle.label.dataset.observed;
    if (handle.root) handle.root.dataset.state = String(value);
    nameFace(handle);
  }

  /** One binding event: recorded for the Inspect view, the label written, the runtime moved. */
  function set(handle, input, value, source, shown) {
    if (!handle || typeof input !== 'string' || handle.state === 'unmounted') return null;
    const did = move(handle, input, value);
    const ev = { input, value, at: now(), source: typeof source === 'string' && source ? source : 'unnamed', did, native: handle.lastNative || null, ...(typeof shown === 'string' && shown && shown !== value ? { shown } : {}) };
    handle.events.push(ev);
    if (handle.events.length > MAX_EVENTS) handle.events.splice(0, handle.events.length - MAX_EVENTS);
    setLabel(handle, input, value, input === 'connection' ? shown : undefined);
    if (input === 'activity' || input === 'connection') {
      // the face's caption follows the source of its state: a preview says PREVIEW, a feed says LIVE (never the other way)
      handle.stateSource = ev.source.startsWith('PREVIEW') ? 'preview' : 'fed';
      if (handle.rive) applyRuns(handle);
    }
    emit(handle, ev);
    return ev;
  }

  /** A Trigger fired only by the person: a trusted click, or Enter / Space on the component. Never automatic. */
  function trigger(handle, input, event) {
    const trusted = event && event.isTrusted === true && (event.type === 'click' || (event.type === 'keydown' && (event.key === 'Enter' || event.key === ' ')));
    if (!trusted || handle.disabled) return null;
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
      hostEl: o.hostEl || null, caption: typeof o.caption === 'string' ? o.caption : null, faceLabel: typeof o.faceLabel === 'string' ? o.faceLabel : null,
      stateSource: null, fedState: undefined, restored: 0, runs: null, contract: null,
      identity: o.identity && typeof o.identity === 'object' ? { ...o.identity } : null, receipt: null, stale: 0,
      providerId: o.providerId || null, providerName: typeof o.providerName === 'string' ? o.providerName : null, providerDetail: typeof o.providerDetail === 'string' ? o.providerDetail : null,
      artboardPick: { preview: Boolean(o.preview), theme: o.theme },
    };
    // on the list BEFORE anything of it can emit (applySeen below): a re-entered component() for the same host finds it
    handles.push(handle);
    if (handle.binds.length) applySeen(handle);
    if (!canvas || typeof assetPath !== 'string' || !assetPath) { wordsOf(handle, assetPath ? 'no canvas' : 'the companion says the file is not here (nothing asked for)'); return handle; }
    handle.artboardBase = handle.artboard;
    attach(handle);
    return handle;
  }
  /** The words path of a handle: the text fallback and the words, never an error. */
  function wordsOf(handle, why) {
    const canvas = handle.canvas;
    handle.state = 'words';
    handle.why = why;
    handle.retryable = why === UNANSWERED_WHY;
    if (canvas) { delete canvas.dataset.loaded; canvas.dataset.riveState = 'words'; }
    if (handle.fallback) handle.fallback.hidden = false;
    if (handle.root) handle.root.dataset.rive = 'words';
    handle.headline = null;
    placeWords(handle); // (a mount on the words path shows its HTML word whatever was asked)
    absentWords(handle).then((words) => { if (handle.note) handle.note.textContent = words; });
  }
  /**
   * Asks the runtime for the handle's file and draws it on its canvas (the handle's state 'loading' → 'drawn' | 'words'). Run
   * once by load(); run again by retry() for a face that went to words only because the listing had not answered.
   */
  function attach(handle) {
    const canvas = handle.canvas;
    const assetPath = handle.asset;
    const toWords = (why) => wordsOf(handle, why);
    handle.state = 'loading';
    handle.retryable = false;
    canvas.dataset.riveState = 'loading';
    runtime().then((rv) => {
      if (handle.state === 'unmounted') return;
      if (!rv) { toWords(runtimeWhy || 'the companion serves no Rive runtime'); return; }
      const patience = setTimeout(() => { if (handle.state === 'loading') toWords(`the file did not load within ${LOAD_PATIENCE_MS / 1000} s`); }, LOAD_PATIENCE_MS);
      // the listing has answered by now (runtime() waits for it): the served file's own artboard for this face (a v2 file's
      // preview variant for the Inspect view, its Glacier button for that theme; a v1 file's three)
      if (handle.artboardBase) handle.artboard = artboardFor(handle.artboardBase, handle.artboardPick);
      if (handle.root && handle.artboard) handle.root.dataset.riveArtboard = handle.artboard; // (data-artboard stays the base name: the CSS keys on it)
      try {
        // (an asset with a native ReducedMotion input keeps playing so its zero-duration transitions settle each pose; the
        // runtime is paused only for an asset without one: see onLoad)
        const r = new rv.Rive({
          src: assetPath, canvas, autoplay: true, enableRiveAssetCDN: false,
          ...(handle.artboard ? { artboard: handle.artboard } : {}),
          ...(handle.stateMachine ? { stateMachines: handle.stateMachine } : {}),
          onAdvance: () => guardState(handle),
          onLoad: () => {
            clearTimeout(patience);
            handle.rive = r;
            handle.state = 'drawn';
            try { r.resizeDrawingSurfaceToCanvas(); } catch (e) { /* drawn at its size */ }
            canvas.dataset.loaded = 'true';
            canvas.dataset.riveState = 'drawn';
            if (handle.fallback) handle.fallback.hidden = true;
            if (handle.root) handle.root.dataset.rive = 'drawn';
            // reduced motion: the asset's own ReducedMotion input when it has one (zero-duration transitions; the runtime
            // settles and stops moving: the operator's design), else the runtime paused on its first frame
            const reduced = inputOf(handle, 'ReducedMotion');
            handle.nativeReduced = Boolean(reduced);
            if (reduced) { try { reduced.value = Boolean(handle.still); } catch (e) { /* the pose stands */ } }
            // the values set while it loaded, applied now
            for (const [k, v] of Object.entries(handle.values)) if (k !== 'welcome') move(handle, k, v);
            // the fed State from here on is what the page set (0 Idle until a feed moves it): the baked click listener cannot
            const si = stateInput(handle);
            if (si && typeof handle.fedState !== 'number') { try { handle.fedState = si.value; } catch (e) { /* unread */ } }
            applyRuns(handle);
            if (handle.still && !reduced) { try { r.pause(); } catch (e) { /* paused */ } }
            emit(handle, { input: null, value: null, at: now(), source: 'runtime', did: `loaded${reduced ? ` (ReducedMotion ${handle.still})` : ''}`, native: null });
          },
          onLoadError: () => { clearTimeout(patience); toWords('the file did not load'); try { r.cleanup(); } catch (e) { /* gone */ } },
        });
      } catch (e) { clearTimeout(patience); toWords(`the runtime refused: ${e && e.message ? e.message : e}`); }
    });
  }
  /**
   * The faces that went to words only because the listing had not answered (no session yet) are asked for again: at the next
   * mount, and when the shell's session arrives (TimmyShell.on('session')). Nothing is re-asked for a face the server said no to.
   */
  function retry(why) {
    const again = handles.filter((x) => x.state === 'words' && x.retryable);
    if (!again.length && !listingUnanswered) return 0;
    listingAsked = null; wordsAsked = null; words = null;
    if (runtimeState !== 'here' && runtimeState !== 'loading') runtimeState = '';
    for (const x of again) { x.events.push({ input: null, value: null, at: now(), source: why || 'asked again', did: 'the listing asked again for this face', native: null }); attach(x); }
    return again.length;
  }

  /**
   * A component in the page: `host` (where it is drawn), `component` (its name), `asset` (/assets/rive/<component>/<file>.riv),
   * `artboard`, `stateMachine`, `role` ('button' for the user-triggered welcome, else 'img'), `label` (the aria label / the
   * heading words), `binds` (the vocabulary feeds it follows: 'connection:<provider>' or 'activity'), `onTrigger(handle, ev)`.
   */
  function component(o) {
    const host = o.host;
    if (listingUnanswered) retry('a new mount: the listing asked again');
    // re-entrancy: the same component asked for the same host while its first making is in flight (a binding event emitted
    // during load() → applySeen() → set() reaching a synchronous redraw that asks again: H172's 06:5x finding, 632 handles for one
    // card at f5730666) gets the handle under way, never a second instance; the same after it is made
    const making = host ? handles.find((x) => x.component === o.component && x.hostEl === host && x.state !== 'unmounted') : null;
    if (making) return making;
    const role = o.role === 'button' ? 'button' : 'img';
    const text = o.text || 'T';
    const canvas = h('canvas', { 'data-timmy-rive': o.component, 'aria-hidden': 'true' });
    const fallback = h('span', { class: 'tr-fallback', 'aria-hidden': 'true' }, text);
    const face = role === 'button'
      ? h('button', { type: 'button', class: 'tr-face', 'aria-label': o.label || o.component, 'data-rive-face': o.component }, canvas, fallback)
      : h('div', { class: 'tr-face', role: 'img', 'aria-label': o.label || o.component, tabindex: '0', 'data-rive-face': o.component }, canvas, fallback);
    const label = h('span', { class: 'tr-status sh-state', 'aria-live': 'polite', 'data-rive-status': o.component }, o.word || (o.binds && o.binds.some((b) => b.startsWith('connection')) ? 'disconnected' : 'idle'));
    const note = h('span', { class: 'tr-note sh-note', 'data-rive-note': o.component });
    const root = h('div', { class: `tr-component tr-${o.component}`, 'data-rive-component': o.component, 'data-rive': 'loading', ...(o.artboard ? { 'data-artboard': o.artboard } : {}), ...(o.size ? { 'data-size': o.size } : {}) }, face, h('span', { class: 'tr-words' }, o.heading ? h('span', { class: 'tr-heading' }, o.heading) : null, label, note));
    if (host) host.append(root);
    const handle = load(canvas, o.asset, { ...o, label, root, fallback, word: label.textContent, hostEl: host || null, faceLabel: o.faceLabel !== undefined ? o.faceLabel : (role === 'button' ? (o.label || text) : null) });
    handle.note = note;
    handle.face = face;
    if (handle.state === 'words') absentWords(handle).then((words) => { note.textContent = words; });
    const fire = (ev) => { const did = trigger(handle, o.triggerInput || 'welcome', ev); if (did && typeof o.onTrigger === 'function') o.onTrigger(handle, did, ev); if (did && ev.type === 'keydown') ev.preventDefault(); };
    // a <button> fires its own (trusted) click for Enter / Space; a role=img face takes the keys itself
    if (role === 'button') face.addEventListener('click', fire);
    else face.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') fire(ev); });
    // the person's pointer and keys on the face → the native Hover / Pressed (trusted events only; never recorded as a state)
    const nat = (input, value, ev) => { if (!ev.isTrusted || handle.disabled) return; if (!handle.rive) return; const n = nativeOf(handle, input, value); if (!n) return; const i = inputOf(handle, n.name); if (i && i.type === 59) { try { i.value = Boolean(value); } catch (e) { /* the pose stands */ } } };
    face.addEventListener('pointerenter', (ev) => nat('hover', true, ev));
    face.addEventListener('pointerleave', (ev) => { nat('hover', false, ev); nat('pressed', false, ev); });
    face.addEventListener('pointerdown', (ev) => nat('pressed', true, ev));
    face.addEventListener('pointerup', (ev) => nat('pressed', false, ev));
    face.addEventListener('pointercancel', (ev) => nat('pressed', false, ev));
    face.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') nat('pressed', true, ev); });
    face.addEventListener('keyup', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') nat('pressed', false, ev); });
    face.addEventListener('focus', (ev) => nat('hover', true, ev));
    face.addEventListener('blur', (ev) => { nat('hover', false, ev); nat('pressed', false, ev); });
    return handle;
  }

  // ── R11 round 6: the mounts the screens call (the real native UI in the product, not thumbnails) ─────────────────────
  const NATIVE_ASSET = '/assets/rive/timmy-ui/timmy-ui.riv';
  const ARTBOARD = Object.freeze({
    AgentConsole: { w: 640, h: 380, component: 'activity', text: '>_' },
    ProviderCard: { w: 400, h: 260, component: 'connection', text: '○' },
    ActionButton: { w: 240, h: 72, component: 'welcome', text: '→' },
  });

  /** The canvas drawn again at the element's size (a mount in a host shown later draws when it is shown); the face's width recorded. */
  function fitWhenShown(handle) {
    if (typeof ResizeObserver === 'undefined' || !handle.face) return;
    const ro = new ResizeObserver(() => {
      const w = handle.face.clientWidth;
      const hgt = handle.face.clientHeight;
      try { if (handle.rive && w > 0) handle.rive.resizeDrawingSurfaceToCanvas(); } catch (e) { /* drawn at its size */ }
      // the face's size in CSS px: since item 4 the runs read the same at every size; the headline's SCALE follows the size (the
      // legibility floor) — fitted again whenever the face's size changes
      if (w > 0) {
        const was = `${handle.faceWidth}×${handle.faceHeight}`;
        handle.faceWidth = w;
        handle.faceHeight = hgt;
        if (handle.rive && handle.state === 'drawn' && was !== `${w}×${hgt}`) fitHeadline(handle);
      }
    });
    ro.observe(handle.face);
    handle.observer = ro;
  }

  /**
   * What every mount adds to its handle: it is a PRODUCTION face (handle.mounted: item 4's rule applies to its runs and its name),
   * where it lives, how its HTML words are shown (`words`: 'beside' — the default, the status word beside the face — or 'spoken':
   * the status stays in the accessibility tree, aria-live, and off the screen while the face is DRAWN and carries the word itself
   * LEGIBLY (the floor: fitHeadline); while the face is not drawn, or its headline cannot reach the floor, the word shows beside
   * the face whatever was asked — handle.wordsAsked is the ask, handle.words the effective mode), unmount(), setLabel().
   */
  function finishMount(handle, o, place) {
    handle.mounted = true;
    handle.place = place;
    handle.size = o.size || 'card';
    handle.wordsAsked = o.words === 'spoken' ? 'spoken' : 'beside';
    handle.headline = null;
    if (handle.root) { handle.root.dataset.place = place; handle.root.dataset.size = handle.size; handle.root.classList.add('tr-mount', `tr-mount-${place}`); }
    nameFace(handle);
    placeWords(handle);
    if (handle.rive) applyRuns(handle);
    handle.setLabel = (words) => { if (handle.label) { handle.word = String(words); handle.label.textContent = handle.word; } if (/^ActionButton/.test(handle.artboard || '')) handle.faceLabel = String(words); if (handle.rive) applyRuns(handle); nameFace(handle); };
    handle.unmount = () => {
      try { if (handle.observer) handle.observer.disconnect(); } catch (e) { /* gone */ }
      try { if (handle.rive) { handle.rive.cleanup(); handle.rive = null; } } catch (e) { /* gone */ }
      handle.stateInputCached = null;
      const i = handles.indexOf(handle);
      if (i >= 0) handles.splice(i, 1);
      if (handle.root && handle.root.parentNode) handle.root.remove();
      handle.state = 'unmounted';
    };
    fitWhenShown(handle);
    return handle;
  }

  /**
   * AgentConsole in a screen (the Chat: H171's call): FED by the activity feed (fromSse / stopping; the derivation stays the
   * fallback), scaled to the host's width at the artboard's 640:380 ('wide' = 100% of the host; 'card' = 320 px); the HTML
   * status label beside it. Returns the handle (handle.root the element, handle.unmount()). A production face (item 4): its
   * headline is the state word the label reads ("idle", "working", "awaiting approval"…), its Title / Tag / Caption / Line runs
   * read "" (`caption` and `identity` are kept on the handle for the Inspect view, not drawn), its aria-label is the state word
   * (`label` is accepted and not used for the name).
   */
  function mountConsole(host, o = {}) {
    const handle = component({
      host, component: o.name || 'console', asset: NATIVE_ASSET, artboard: 'AgentConsole', stateMachine: TIMMY_UI.stateMachine, role: 'img', theme: o.theme,
      // binds: the Chat's console follows the turn's events ('activity'); a Control Room run's face follows that run alone
      // ('job:<run>', fed by fromJob), so a chat turn never moves a run's face and a run never moves the Chat's
      label: o.label || 'Agent activity', heading: o.heading === undefined ? 'AGENT ACTIVITY' : o.heading, text: ARTBOARD.AgentConsole.text, binds: Array.isArray(o.binds) && o.binds.length ? o.binds.slice() : ['activity'], word: o.word || 'idle', size: o.size,
      caption: typeof o.caption === 'string' ? o.caption : undefined, identity: o.identity,
    });
    finishMount(handle, o, o.place || 'chat');
    /** The feed's identity this console follows (project / session from the screen; the turn from the 'turn' event). */
    handle.setIdentity = (id) => { handle.identity = { ...(handle.identity || {}), ...(id || {}) }; if (handle.rive) applyRuns(handle); };
    return handle;
  }

  /**
   * ProviderCard on a provider's card (the Connections screen: H170's call): bound 'connection:<providerId>', its State from
   * fromProviderState(providerId, stateWord) (and, until that line, from the card's drawn data-state); connected = State 0 +
   * the label (no success pose is authored). A production face (item 4): its headline in every pose is the OBSERVED word the label
   * reads ("checked", "pending", "not set up"…), its Title / Tag / Caption / ProviderName / ProviderState / ProviderDetail runs read
   * "", its aria-label is "<the word> · <the provider's name>" (`providerName` names it; `label` is accepted and not used for the
   * name; `detail` is kept on the handle, not drawn).
   */
  function mountProviderCard(host, providerId, o = {}) {
    const id = String(providerId || '');
    const handle = component({
      host, component: o.name || `provider:${id}`, asset: NATIVE_ASSET, artboard: 'ProviderCard', stateMachine: TIMMY_UI.stateMachine, role: 'img', theme: o.theme,
      label: o.label || `Connection to ${id}`, heading: o.heading === undefined ? null : o.heading, text: ARTBOARD.ProviderCard.text, binds: [`connection:${id}`], word: o.word || 'disconnected', size: o.size,
      caption: typeof o.caption === 'string' ? o.caption : undefined, providerId: id, providerName: typeof o.providerName === 'string' ? o.providerName : undefined, providerDetail: typeof o.detail === 'string' ? o.detail : undefined,
    });
    handle.provider = id;
    finishMount(handle, o, o.place || 'connections');
    /**
     * The card's provider words (the screen's title and one line): since item 4 a production face draws neither (its runs read "");
     * the name is the second half of the face's accessible name ("checked · OpenRouter"), the detail is the screen's own line.
     */
    handle.setProvider = (w) => { if (w && typeof w.name === 'string') handle.providerName = w.name; if (w && typeof w.detail === 'string') handle.providerDetail = w.detail; if (handle.rive) applyRuns(handle); nameFace(handle); };
    return handle;
  }

  /**
   * ActionButton wired to a REAL action of the screen's (the NEEDS-YOU answer through POST /api/chat/answer, the welcome's
   * starter: H171's handlers; never a route of this module's): a real <button type="button" aria-label=label> wrapping the
   * canvas; Hover/Pressed native from the person's pointer and keys; a TRUSTED click / Enter / Space calls `action(event)`;
   * setDisabled(bool) sets the button's disabled attribute (the label says "unavailable"); the HTML label beside it is `label`.
   */
  function mountActionButton(host, o = {}) {
    const words = String(o.label || 'Action');
    const handle = component({
      host, component: o.name || 'action', asset: NATIVE_ASSET, artboard: 'ActionButton', stateMachine: TIMMY_UI.stateMachine, role: 'button', theme: o.theme,
      label: words, heading: o.heading === undefined ? null : o.heading, text: o.text || words, binds: [], word: words, size: o.size,
      triggerInput: 'welcome',
      // the screen's own action gets the person's DOM event (trusted; the binding event is recorded on the handle)
      onTrigger: (hd, _did, ev) => { if (hd.disabled) return; if (typeof o.action === 'function') { try { o.action(ev); } catch (e) { /* the screen's own */ } } },
    });
    finishMount(handle, o, o.place || 'chat');
    handle.setDisabled = (on) => {
      handle.disabled = Boolean(on);
      if (handle.face) { if (handle.disabled) handle.face.setAttribute('disabled', ''); else handle.face.removeAttribute('disabled'); handle.face.setAttribute('aria-disabled', String(handle.disabled)); }
      if (handle.label) handle.label.textContent = handle.disabled ? `${words} · unavailable` : words;
      if (handle.root) handle.root.dataset.disabled = String(handle.disabled);
      // the native poses off while it cannot be pressed
      if (handle.disabled && handle.rive) { for (const n of ['Hover', 'Pressed']) { const i = inputOf(handle, n); if (i) { try { i.value = false; } catch (e) { /* the pose stands */ } } } }
    };
    if (o.disabled) handle.setDisabled(true);
    return handle;
  }

  /** Every handle bound to `bind` ('connection:<id>' or 'activity'). */
  const bound = (bind) => handles.filter((x) => x.binds.includes(bind));

  /** The page's theme family ('amber' | 'glacier'; H175's data-theme on <html>, else amber). */
  function themeOf(o) {
    if (o && (o.theme === 'glacier' || o.theme === 'amber')) return o.theme;
    try { const t = document.documentElement.dataset.theme; return t === 'glacier' ? 'glacier' : 'amber'; } catch (e) { return 'amber'; }
  }
  /**
   * The artboard a mount asks the SERVED file for: the listing says which contract the file is (its rive.yaml `contract`, read by
   * rive-assets.ts) and which artboards it has; a v2 file offers ActionButtonGlacier for the Glacier theme and the preview
   * variants for the Inspect view; a v1 file has the three production artboards only.
   */
  function artboardFor(base, o = {}) {
    const l = listingInfo || {};
    const boards = Array.isArray(l.artboards) ? l.artboards : [];
    const previews = Array.isArray(l.previewArtboards) ? l.previewArtboards : [];
    if (o.preview && previews.includes(`${base}Preview`)) return `${base}Preview`;
    if (base === 'ActionButton' && themeOf(o) === 'glacier' && boards.includes('ActionButtonGlacier')) return 'ActionButtonGlacier';
    return base;
  }

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
    const shown = typeof stateWord === 'string' ? stateWord.trim() : '';
    const src = source || `GET /api/connections: ${id} "${stateWord}"`;
    lastSeen[`connection:${id}`] = { word, source: src, shown };
    const out = [];
    for (const x of bound(`connection:${id}`)) out.push(set(x, 'connection', word, src, shown));
    for (const x of bound('connection')) out.push(set(x, 'connection', word, src, shown));
    return out;
  }
  /** H169's SSE event → the activity vocabulary (null when the event moves nothing: route, delta, tool ran, …). */
  function activityWordOf(event, data) {
    if (event === 'turn' || event === 'route' || event === 'delta') return 'working';
    if (event === 'tool') return 'working'; // asked, ran, refused or failed: the turn goes on; the turn's own end says how
    if (event === 'needs-you') return 'awaiting';
    if (event === 'error') return 'failed';
    if (event === 'done') { const s = data && data.status; return s === 'cancelled' ? 'stopped' : s === 'failed' ? 'failed' : 'idle'; }
    return null;
  }
  /**
   * Whether the page's own code has FED the activity (H171's chat-shell.js: TimmyRive.fromSse per SSE event of POST /api/chat/turn,
   * TimmyRive.stopping on Stop): from then on the feed is the truth and the derivation (watchPage) steps back for the activity;
   * on a page where the feed never spoke, the derivation stays the fallback. The Inspect view's events show which source set each state.
   */
  let activityFed = false;
  function feedActivity(word, src) {
    activityFed = true;
    lastSeen.activity = { word, source: src };
    return bound('activity').map((x) => set(x, 'activity', word, src));
  }
  /**
   * The turn feed's identity (R11 round 7): a 'turn' event names the current turn (data.id); a 'needs-you' or 'done' that names
   * ANOTHER turn (data.turn) is stale — recorded on every console as such, never applied; 'done' attaches its receipt (data.receipt)
   * to the consoles and the feed. A later 'turn' starts the next turn. The identity and the receipt show in the Inspect view.
   */
  const feed = { turn: null, receipt: null, stale: 0 };
  function fromSse(event, data, source) {
    const src = source || `SSE ${event}${data && data.status ? ` (${data.status})` : ''}`;
    const named = data && typeof data === 'object' ? (event === 'turn' ? data.id : data.turn) : null;
    if (event === 'turn' && typeof named === 'string' && named) {
      feed.turn = named; feed.receipt = null;
      for (const x of bound('activity')) { x.identity = { ...(x.identity || {}), turn: named }; x.receipt = null; if (x.rive) applyRuns(x); }
    } else if ((event === 'needs-you' || event === 'done') && typeof named === 'string' && named && feed.turn && named !== feed.turn) {
      // another turn's event (a late stream, a reconnect's replay): ignored, said
      feed.stale += 1;
      for (const x of bound('activity')) { x.stale = (x.stale || 0) + 1; x.events.push({ input: 'activity', value: null, at: now(), source: src, did: `ignored: names turn ${named}, this console follows turn ${feed.turn}`, native: null, stale: true }); if (x.events.length > MAX_EVENTS) x.events.splice(0, x.events.length - MAX_EVENTS); }
      return [];
    }
    if (event === 'done' && data && typeof data === 'object' && data.receipt) {
      const receipt = typeof data.receipt === 'string' ? data.receipt : (data.receipt && typeof data.receipt === 'object' && (data.receipt.id || data.receipt.hash)) || null;
      if (receipt) { feed.receipt = receipt; for (const x of bound('activity')) x.receipt = receipt; }
    }
    const word = activityWordOf(event, data);
    if (!word) return [];
    return feedActivity(word, src);
  }
  /** STOP REQUESTED: the word 'stopping' (State 1: the turn still runs) until the backend's 'done' says cancelled → stopped. */
  const stopping = (source) => feedActivity('stopping', source || 'POST /api/chat/stop');
  /**
   * After a reconnect the screen re-reads the turn's state and applies it here: a word of the activity vocabulary for the turn
   * named (another turn's is ignored, said); the source names the read (e.g. 'GET /api/chat/turn/<id>').
   */
  function reconcile(word, o = {}) {
    const w = String(word || '');
    if (!VOCAB.activity.includes(w)) return [];
    if (o.turn && feed.turn && o.turn !== feed.turn) { feed.stale += 1; return []; }
    if (o.turn && !feed.turn) { feed.turn = o.turn; for (const x of bound('activity')) { x.identity = { ...(x.identity || {}), turn: o.turn }; if (x.rive) applyRuns(x); } }
    return feedActivity(w, o.source || 'reconciled after a reconnect');
  }

  /**
   * The vocabularies derived from what the screens draw, until their owners feed the events themselves: H170's cards carry
   * data-provider + data-state (the providerStates word from GET /api/connections); H171's turns are li.cx-turn.is-timmy
   * with is-streaming / is-answered / is-stopped / is-failed, a needs-you box as .cx-needs. Each event says it is derived.
   */
  let watching = null;
  /** The last state derived per bind ('connection:<id>' → { word, source }; 'activity' → { word, source }): a handle bound later takes it. */
  const lastSeen = {};
  /** A handle made after the page's state was seen takes that state (H172's finding: a card already checked when the view opens). */
  function applySeen(handle) {
    for (const b of handle.binds) {
      const key = b === 'connection' ? null : b;
      const hit = key ? lastSeen[key] : null;
      if (hit) set(handle, b.startsWith('connection') ? 'connection' : 'activity', hit.word, hit.source, hit.shown);
    }
  }
  function watchPage() {
    if (watching || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return watching;
    const seen = {};
    const look = () => {
      for (const card of document.querySelectorAll('[data-provider][data-state]')) {
        const id = card.getAttribute('data-provider');
        const st = card.getAttribute('data-state');
        if (seen[`c:${id}`] === st) continue;
        seen[`c:${id}`] = st;
        const source = `derived from the page's drawing of GET /api/connections: ${id} data-state="${st}"`;
        fromProviderState(id, st, source);
      }
      // the activity: the feed's, once it spoke (H171's chat-shell.js); derived from the drawing only until then
      if (activityFed) return;
      // the page's own turn in flight (#cx-own: li.cx-turn.is-timmy with its state class) comes first; the saved conversation's
      // turns (#cx-turns) carry no state class and say nothing of what runs now
      const own = [...document.querySelectorAll('#cx-own li.cx-turn.is-timmy')];
      const saved = document.querySelectorAll('#cx-turns li.cx-turn.is-timmy');
      const indexOf = (li) => (li && li.dataset.own !== undefined ? Number(li.dataset.own) : -1);
      const streaming = own.filter((li) => li.classList.contains('is-streaming'));
      // what was seen so far: the newest own turn seen STREAMING, and the newest seen stopped or failed (a stopped or failed own
      // turn stays in #cx-own while an answered one folds into the saved conversation once its receipt is read back)
      for (const li of streaming) seen.streamed = Math.max(seen.streamed === undefined ? -1 : seen.streamed, indexOf(li));
      for (const li of own) if (li.classList.contains('is-stopped') || li.classList.contains('is-failed')) seen.ended = Math.max(seen.ended === undefined ? -1 : seen.ended, indexOf(li));
      const stopShown = Boolean(document.querySelector('#cx-send.is-stop'));
      const last = own[own.length - 1] || saved[saved.length - 1];
      let word = null;
      let why = '';
      let key = '';
      // a turn answered AFTER a stopped (or failed) one: it was SEEN streaming, newer than the stopped li, it is gone from #cx-own
      // (folded into the saved conversation, sealed), nothing streams and no Stop is offered → idle. Never before a turn was seen
      // streaming (a turn just started, or one that ran before this page drew it, says nothing here): the is-answered path says idle.
      if (seen.ended !== undefined && seen.streamed !== undefined && seen.streamed > seen.ended && !streaming.length && !stopShown && !own.some((li) => indexOf(li) === seen.streamed)) {
        word = 'idle'; why = `the page's newest turn (data-own ${seen.streamed}, seen streaming after the stopped one) folded into the saved conversation (answered, sealed)`; key = `idle:folded:${seen.streamed}`;
      } else if (last) {
        if (last.classList.contains('is-streaming')) { word = last.querySelector('.cx-needs') ? 'awaiting' : 'working'; why = word === 'awaiting' ? 'li.cx-turn.is-streaming with .cx-needs (needs-you)' : 'li.cx-turn.is-streaming'; }
        else if (last.classList.contains('is-stopped')) { word = 'stopped'; why = 'li.cx-turn.is-stopped'; }
        else if (last.classList.contains('is-failed')) { word = 'failed'; why = 'li.cx-turn.is-failed'; }
        else if (last.classList.contains('is-answered')) { word = 'idle'; why = 'li.cx-turn.is-answered (done)'; }
        key = `${word}:${last.dataset.own || ''}`;
      }
      if (word && seen.activity !== key) {
        seen.activity = key;
        const source = `derived from the page's drawing of the turn: ${why}`;
        lastSeen.activity = { word, source };
        for (const x of bound('activity')) set(x, 'activity', word, source);
      }
    };
    watching = new MutationObserver(() => { try { look(); } catch (e) { /* the next change */ } });
    watching.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'class'] });
    // Stop: the composer's button while it reads Stop (#cx-send.is-stop: the page's own turn, or another surface's), by a trusted
    // click or the form's submit (Enter in the composer)
    const derivedStop = (source) => { if (activityFed) return; lastSeen.activity = { word: 'stopping', source }; for (const x of bound('activity')) set(x, 'activity', 'stopping', source); };
    const stopPressed = (ev) => { if (!ev.isTrusted) return; const t = ev.target && ev.target.closest ? ev.target.closest('#cx-send.is-stop, [data-cx="stop"], [data-cx="stop-other"]') : null; if (t) derivedStop("derived from the page's Stop button (POST /api/chat/stop)"); };
    document.addEventListener('click', stopPressed, true);
    document.addEventListener('submit', (ev) => { if (!ev.isTrusted) return; const f = ev.target; const b = f && f.querySelector ? f.querySelector('#cx-send.is-stop') : null; if (b) derivedStop("derived from the page's Stop (the composer submitted while it reads Stop; POST /api/chat/stop)"); }, true);
    look();
    return watching;
  }

  /** What each component is now: for the Inspect view. Nothing here is a receipt or a progress number. */
  function inspect() {
    return handles.map((x) => ({
      id: x.id, component: x.component, asset: x.asset, artboard: x.artboard, stateMachine: x.stateMachine, state: x.state, why: x.why, still: x.still,
      word: x.word, values: { ...x.values }, binds: x.binds.slice(), events: x.events.slice(), runtime: report(x), sources: x.sources.slice(),
      nativeReduced: Boolean(x.nativeReduced), contract: x.stateMachine === TIMMY_UI.stateMachine ? 'TimmyUI' : null, place: x.place || 'inspect', disabled: Boolean(x.disabled),
      runs: x.runs ? JSON.parse(JSON.stringify(x.runs)) : null, stateSource: x.stateSource, fedState: x.fedState, restored: x.restored || 0,
      fileContract: x.contract, identity: x.identity ? { ...x.identity } : null, receipt: x.receipt || null, stale: x.stale || 0, retryable: Boolean(x.retryable),
      shown: x.shown || null, faceWidth: typeof x.faceWidth === 'number' ? x.faceWidth : null,
      mounted: Boolean(x.mounted), words: x.words || null, wordsAsked: x.wordsAsked || null, wordsWhy: x.wordsWhy || null, faceName: x.face ? x.face.getAttribute('aria-label') : null,
      faceHeight: typeof x.faceHeight === 'number' ? x.faceHeight : null, headline: x.headline ? { ...x.headline, room: { ...x.headline.room } } : null,
    }));
  }

  /**
   * A Control Room run's face (mountConsole with binds ['job:<run>']): its state word from the run's record — running →
   * working, stopping → stopping, stopped → stopped, failed / interrupted / refused → failed, succeeded → idle (no success pose
   * is authored; the HTML word beside it says "succeeded"). `ended`: the record's end, captioned ENDED, never LIVE.
   */
  function fromJob(handle, word, source, ended) {
    if (!handle || !handle.binds || !handle.binds.some((b) => b.startsWith('job:'))) return null;
    handle.jobEnded = Boolean(ended);
    return set(handle, 'activity', word, source);
  }

  /** PREVIEW: moves the animation only (recorded with the source 'PREVIEW'); it writes no state anywhere, shows nothing else. */
  const preview = (handle, input, value) => set(handle, input, value, 'PREVIEW — not an execution, no progress, no receipt');

  W.TimmyRive = Object.freeze({
    VERSION: 'r11-r7', VOCAB, RUNTIME_PATH, WASM_PATH, FALLBACK_WORDS, TIMMY_UI, RUNS, CAPTION, nativeOf,
    component, load, set, trigger, preview, inspect, fromProviderState, fromSse, fromJob, stopping, reconcile, retry, watchPage, connectionWordOf, activityWordOf, absentWords, providerNameOf, themeOf,
    feed: () => ({ ...feed }), served: () => (listingInfo ? JSON.parse(JSON.stringify(listingInfo)) : null),
    mountConsole, mountProviderCard, mountActionButton, NATIVE_ASSET, ARTBOARD,
    words: askWords, runtime, runtimeState: () => runtimeState, runtimeWhy: () => runtimeWhy, activityFed: () => activityFed, handles: () => handles.slice(), on: (fn) => { if (typeof fn !== 'function') return () => {}; listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    reducedMotion: still,
    /** For a page that unloads: the runtimes let go. */
    cleanup: () => { for (const x of handles) { try { if (x.rive) x.rive.cleanup(); } catch (e) { /* gone */ } } },
  });
  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => W.TimmyRive.cleanup());
  // the session's arrival (the shell's 'session' event with a user): the listing is asked again for every face that waited on it
  let sessionHooked = false;
  const hookSession = () => {
    const sh = W.TimmyShell;
    if (sessionHooked || !sh || typeof sh.on !== 'function') return sessionHooked;
    sessionHooked = true;
    sh.on('session', (e) => { if (e && e.user) retry('the session arrived: the listing asked again'); });
    return true;
  };
  if (!hookSession() && typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', hookSession, { once: true });
})();
