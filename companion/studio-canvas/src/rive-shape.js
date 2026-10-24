// R11 round 5 (H174): the `timmy-rive` shape — a native, editable Rive component on Timmy Canvas: an HTMLContainer holding a
// <canvas> driven by window.TimmyRive (src/companion/client/rive-bindings.js, bundled here for its side effect), the state word
// drawn in HTML beside the canvas (aria-live), selection and expansion bound to tldraw's own selection and size as the two
// Bool inputs `selected` / `expanded`. Props: component (the folder under /assets/rive/), state (the vocabulary word the shape
// shows: its backend-driven value when the page feeds one, else what was saved), label (its heading). Keyboard reachable as
// the other shapes (tldraw's selection; the face is a focusable role="img" element; Enter / Space on a welcome fires its trigger).
//
// The runtime and the asset come from THIS page's origin (/vendor/rive/rive.js + rive.wasm, /assets/rive/<component>/<file>):
// the Studio's server serves them once mountRive + mountRiveAssets are mounted there (src/studio/server.ts); until then the
// shape shows its words and the text mark — never an error, never a drawn stand-in that looks like the animation.
//
// Follows cards.js's ShapeUtil pattern: BaseBoxShapeUtil, HTMLContainer, a props schema with T, the width the person's, the
// height following the content. Nothing here imports anything but the bindings; canvas.js hands in React and tldraw's classes.
import '../../../src/companion/client/rive-bindings.js';

export const RIVE_SHAPE = 'timmy-rive';
/** The operator's native asset (src/companion/assets/rive/timmy-ui/timmy-ui.riv): one state machine TimmyUI on three artboards. */
export const NATIVE_ASSET = '/assets/rive/timmy-ui/timmy-ui.riv';
/**
 * The components a shape may show: each is an artboard of the native asset (the contract in its README: State 0 Idle · 1
 * Working/Checking · 2 Approval · 3 Stopped · 4 Failed, Hover, Pressed, ReducedMotion), with the page's vocabulary mapped on it
 * by rive-bindings.js (connected has no success pose: State 0, the label says it; stopping → 1 until cancelled → 3).
 */
export const RIVE_COMPONENTS = Object.freeze({
  welcome: { artboard: 'ActionButton', stateMachine: 'TimmyUI', input: 'welcome', words: ['welcome'], text: 'T', role: 'button' },
  connection: { artboard: 'ProviderCard', stateMachine: 'TimmyUI', input: 'connection', words: ['disconnected', 'checking', 'connected', 'failed'], text: '○', role: 'img' },
  activity: { artboard: 'AgentConsole', stateMachine: 'TimmyUI', input: 'activity', words: ['idle', 'working', 'awaiting', 'stopping', 'stopped', 'failed'], text: '>_', role: 'img' },
});
export const RIVE_WIDTH = 240;
export const RIVE_HEIGHT = 200;
/**
 * A new shape's width per component, so each face reads at 100 %: the AgentConsole (640:380) at 480 → a 454×270 face, its
 * 19 px labels ~13 px; the ProviderCard (400:260) at 320 → 294×191; the ActionButton (240:72) at 280 → 254×76 (≥ 200 px, a
 * button). The face fills the shape's content width at the artboard's aspect (index.html: the component is a block grid).
 */
export const RIVE_WIDTH_OF = Object.freeze({ welcome: 280, connection: 320, activity: 480 });
/** The default width of a component's shape (RIVE_WIDTH for an unknown one). */
export const widthOf = (component) => RIVE_WIDTH_OF[component] || RIVE_WIDTH;
/** Expanded when the person made the shape at least this much wider than its default. */
export const EXPAND_AT = 1.5;
/** What the shape says of a state word that no backend event set on this page (a saved word is a record, not an observation). */
export const SAVED_WORDS = 'as saved with the board; no backend event has set it on this page';

/** The asset path of a component: the native asset (every component is one of its artboards). */
export const assetOf = () => NATIVE_ASSET;

/** Whether a store record is this shape. */
export const isRiveShape = (r) => !!r && r.typeName === 'shape' && r.type === RIVE_SHAPE;

/** The props a new shape of `component` starts with. */
export function riveProps(component, o = {}) {
  const c = RIVE_COMPONENTS[component] ? component : 'welcome';
  return { w: o.w ?? widthOf(c), h: o.h ?? RIVE_HEIGHT, component: c, state: o.state ?? (c === 'connection' ? 'disconnected' : c === 'activity' ? 'idle' : 'ready'), label: o.label ?? (c === 'connection' ? 'Provider connection' : c === 'activity' ? 'Agent / tool activity' : 'Welcome / guide'), provider: o.provider ?? '' };
}

/**
 * The shape util and what feeds it. `deps`: React, BaseBoxShapeUtil, HTMLContainer, T, useValue, resizeBox (from tldraw);
 * editor() (the live editor). The page's TimmyRive is the one bundled here (window.TimmyRive).
 */
export function createRiveShape(deps) {
  const { React, BaseBoxShapeUtil, HTMLContainer, T, useValue, resizeBox } = deps;
  const h = React.createElement;
  const R = () => (typeof window !== 'undefined' ? window.TimmyRive : null);

  function RiveFace({ shape }) {
    const p = shape.props;
    const def = RIVE_COMPONENTS[p.component] || RIVE_COMPONENTS.welcome;
    const ref = React.useRef(null);
    const handleRef = React.useRef(null);
    const [word, setWord] = React.useState(p.state);
    const [source, setSource] = React.useState(SAVED_WORDS);
    const editor = deps.editor();
    const selected = useValue('timmy rive: selected', () => { const ed = deps.editor(); return ed ? ed.getSelectedShapeIds().includes(shape.id) : false; }, [shape.id]);
    const expanded = p.w >= widthOf(p.component) * EXPAND_AT; // 1.5× the component's own default width
    // the component, made once per shape element, bound to the page's feed of its vocabulary
    React.useEffect(() => {
      const host = ref.current;
      const rive = R();
      if (!host || !rive) return undefined;
      host.replaceChildren();
      const binds = p.component === 'connection' ? [p.provider ? `connection:${p.provider}` : 'connection'] : p.component === 'activity' ? ['activity'] : [];
      const handle = rive.component({
        host, component: `${p.component}${p.provider ? `:${p.provider}` : ''}`, asset: assetOf(p.component), artboard: def.artboard, stateMachine: def.stateMachine,
        role: def.role, label: p.label, text: def.text, binds, triggerInput: def.input === 'welcome' ? 'welcome' : null, word: p.state,
        // the face's caption until a backend event sets its state on this page (then LIVE / its feed); a welcome's face label is its own
        caption: 'AS SAVED  /  NOT A LIVE JOB', faceLabel: def.input === 'welcome' ? p.label : undefined,
      });
      handleRef.current = handle;
      const off = rive.on((hd, ev) => {
        if (hd !== handle || !ev.input || ev.input === 'selected' || ev.input === 'expanded') return;
        setWord(hd.word);
        setSource(ev.source);
        // the state word the shape keeps with the board (what was observed last on this page)
        const ed = deps.editor();
        if (ed && ev.input === def.input && typeof ev.value === 'string' && ev.value !== shape.props.state) {
          try { ed.run(() => ed.updateShape({ id: shape.id, type: shape.type, props: { state: ev.value } }), { history: 'ignore' }); } catch (e) { /* the word on the face stands */ }
        }
      });
      return () => { off(); try { if (handle.rive) handle.rive.cleanup(); } catch (e) { /* gone */ } handleRef.current = null; };
    }, [shape.id, p.component, p.provider]);
    // the height follows the content (the artboard at the shape's width, the lines under it), as the cards' does
    const innerRef = React.useRef(null);
    React.useLayoutEffect(() => {
      const el = innerRef.current;
      const ed = deps.editor();
      if (!el || !ed || typeof ResizeObserver === 'undefined') return undefined;
      const fit = () => {
        const want = Math.max(80, Math.ceil(el.scrollHeight) + 2);
        const now = ed.getShape(shape.id);
        if (now && Math.abs(now.props.h - want) > 1) { try { ed.run(() => ed.updateShape({ id: shape.id, type: shape.type, props: { h: want } }), { history: 'ignore' }); } catch (e) { /* the next frame */ } }
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(el);
      return () => ro.disconnect();
    }, [shape.id, shape.type]);
    // selection and expansion: tldraw's own facts, as the two Bool inputs
    React.useEffect(() => { const rive = R(); const hd = handleRef.current; if (rive && hd) rive.set(hd, 'selected', selected, 'tldraw selection'); }, [selected]);
    React.useEffect(() => { const rive = R(); const hd = handleRef.current; if (rive && hd) rive.set(hd, 'expanded', expanded, `tldraw size (w ${Math.round(p.w)} ≥ ${widthOf(p.component) * EXPAND_AT} is expanded)`); }, [expanded]);
    const handled = (e) => { const ed = deps.editor(); if (ed) ed.markEventAsHandled(e); };
    // R11 round 6: the artboard chosen on the shape itself (a native <select>, keyboard reachable): the props change, the board
    // save (save-state.js) carries them, the component is made again for the new artboard (the effect above keys on it)
    const choose = (e) => {
      const next = String(e.target.value);
      const ed = deps.editor();
      if (!ed || !RIVE_COMPONENTS[next] || next === p.component) return;
      const fresh = riveProps(next, { w: p.w, h: p.h, provider: p.provider });
      ed.updateShape({ id: shape.id, type: shape.type, props: { component: next, state: fresh.state, label: fresh.label } });
    };
    const ARTBOARD_WORDS = { welcome: 'ActionButton', connection: 'ProviderCard', activity: 'AgentConsole' };
    return h(HTMLContainer, { className: `tr-shape tr-shape-${p.component}${selected ? ' is-selected' : ''}${expanded ? ' is-expanded' : ''}`, 'data-timmy-rive-shape': shape.id, 'data-component': p.component, 'data-state': word, style: { width: p.w, height: p.h, pointerEvents: 'all' } },
      h('div', { ref: innerRef, className: 'tr-shape-inner', role: 'group', 'aria-label': `${p.label}: ${word}` },
        h('div', { className: 'tr-shape-head' }, h('strong', { className: 'tr-shape-title' }, p.label),
          h('label', { className: 'tr-shape-pick' }, h('span', { className: 'tr-visually-hidden' }, 'Artboard'),
            h('select', { className: 'tr-shape-select', value: p.component, 'aria-label': 'Artboard', 'data-rive-pick': shape.id, onPointerDown: handled, onChange: choose },
              ...Object.keys(RIVE_COMPONENTS).map((k) => h('option', { key: k, value: k }, ARTBOARD_WORDS[k])))),
          h('span', { className: 'tr-badge' }, 'RIVE')),
        h('div', { ref, className: 'tr-shape-art', onPointerDown: handled }),
        h('p', { className: 'tr-shape-source', title: source }, source.startsWith('derived') ? 'derived from the page’s drawing of a backend event' : source === SAVED_WORDS ? SAVED_WORDS : `from ${source}`),
        expanded ? h('p', { className: 'tr-shape-more' }, `${def.artboard} · ${def.stateMachine}: State, Hover, Pressed, ReducedMotion · this page's ${def.input}: ${def.words.join(' · ')} · selected → Hover · expanded: HTML only`) : null,
        h('p', { className: 'tr-shape-foot' }, selected ? 'selected' : 'not selected', ' · ', expanded ? 'expanded (resize narrower to fold)' : 'resize wider to expand', editor ? '' : '')));
  }

  const props = { w: T.number, h: T.number, component: T.string, state: T.string, label: T.string, provider: T.string };
  class RiveShapeUtil extends BaseBoxShapeUtil {
    static type = RIVE_SHAPE;
    static props = props;
    getDefaultProps() { return riveProps('welcome'); }
    hideRotateHandle() { return true; }
    canEdit() { return false; }
    // The width is the person's (it is what expands the component); the height follows the content's minimum.
    // The width is the person's (it is what expands the component and scales the artboard); the height follows the content.
    onResize(shape, info) { const next = resizeBox(shape, info); return { ...next, y: shape.y, props: { ...next.props, h: shape.props.h } }; }
    getText(shape) { return `${shape.props.label}\n${shape.props.state}`; }
    component(shape) { return h(RiveFace, { shape }); }
    getIndicatorPath(shape) { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path; }
  }
  /** Places a shape of `component` at `at` ({ x, y }) on `editor`; returns its id. */
  function place(editor, component, at, o = {}) {
    const id = deps.createShapeId ? deps.createShapeId() : undefined;
    const { at: _at, ...props } = o;
    editor.createShape({ ...(id ? { id } : {}), type: RIVE_SHAPE, x: at.x, y: at.y, props: riveProps(component, props) });
    return id;
  }
  return { util: RiveShapeUtil, place, RIVE_SHAPE, RIVE_COMPONENTS };
}
