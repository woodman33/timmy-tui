// The unified Workspace order (2026-10-27): one display node for whatever an app delivered, on the licensed tldraw canvas,
// with the same contextual controls everywhere (the addendum's table):
//   header     its type and title, its status, the view/mode selector and the action menu (the shared dropdown, src/menu.jsx)
//   body       the work itself — an image, a video, an interactive 3D model, an isolated HTML preview, a Rive file playing on
//              the Rive runtime with its state machine's inputs, or, for a native/source file, a reference to reopen
//   inspector  collapsible: where it came from (app, document, job, receipt, the file's hash as its receipt names it) and its
//              parameters
//   foot       ONE primary action, and the source, the outputs and the receipt
// A press on a control never drags the node or pans the camera (the controls stop their events); the header is the node's
// handle. Each node's meta keeps where it came from (app, path, receipt), as an import always did.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BaseBoxShapeUtil, HTMLContainer, T, resizeBox } from 'tldraw';
import { call, getJson, postJson } from '../api.js';
import { appName } from '../app-names.js';
import { MenuButton, MenuGroup, MenuItem, keepOut } from '../menu.jsx';
import { aimAgent, openApp, projectQuery, say, showInFiles } from '../store.js';

export const DISPLAY_SHAPE = 'timmy-display';
const EXT = (p) => (/\.([a-z0-9]+)$/i.exec(String(p || '')) || [])[1]?.toLowerCase() || '';
export const KINDS = Object.freeze({
  image: { word: 'IMAGE', exts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'], modes: [['fit', 'Fit'], ['fill', 'Fill'], ['actual', 'Actual size']] },
  video: { word: 'VIDEO', exts: ['mp4', 'webm', 'mov', 'm4v'], modes: [['player', 'Player'], ['loop', 'Loop, muted']] },
  model: { word: '3D', exts: ['glb'], modes: [['solid', 'Solid'], ['wireframe', 'Wireframe']] },
  html: { word: 'HTML', exts: ['html', 'htm'], modes: [['preview', 'Preview'], ['source', 'Source']] },
  rive: { word: 'RIVE', exts: ['riv'], modes: [['play', 'Playing'], ['paused', 'Paused']] },
  file: { word: 'FILE', exts: [], modes: [['reference', 'Reference']] },
});
/** What a file becomes on the canvas, by its extension. */
export function displayKindOf(path) {
  const e = EXT(path);
  for (const [k, d] of Object.entries(KINDS)) if (d.exts.includes(e)) return k;
  return 'file';
}
/** Each app's own name for its native or editable sources (shown on a reference node). */
const NATIVE = Object.freeze({ blend: 'Blender scene', usda: 'USD stage', usd: 'USD stage', scad: 'OpenSCAD source', stl: 'STL mesh', step: 'STEP solid', stp: 'STEP solid', rml: 'Rive markup source', json: 'JSON record', fcstd: 'FreeCAD document', aep: 'After Effects project', c4d: 'Cinema 4D scene', ai: 'Illustrator artwork', txt: 'text', md: 'Markdown', csv: 'table' });

const media = new Map();
/** A project file's bytes as an object URL for this page (fetched once, with the page's token, through GET /api/files/media). */
export async function mediaUrl(path) {
  if (media.has(path)) return media.get(path);
  const p = (async () => {
    const r = await call(`/api/files/media?path=${encodeURIComponent(path)}${projectQuery('&')}`);
    if (!r.ok) throw new Error(`the companion answered ${r.status}`);
    return URL.createObjectURL(await r.blob());
  })();
  media.set(path, p);
  p.catch(() => media.delete(path));
  return p;
}
async function mediaBytes(path) {
  const r = await call(`/api/files/media?path=${encodeURIComponent(path)}${projectQuery('&')}`);
  if (!r.ok) throw new Error(`the companion answered ${r.status}`);
  return r.arrayBuffer();
}

const stopAll = { ...keepOut, onKeyDown: (e) => e.stopPropagation() };

// ── the bodies ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function useMedia(path) {
  const [u, setU] = useState({ state: 'reading' });
  useEffect(() => {
    let gone = false;
    setU({ state: 'reading' });
    mediaUrl(path).then((url) => { if (!gone) setU({ state: 'ok', url }); }, (e) => { if (!gone) setU({ state: 'failed', why: e.message }); });
    return () => { gone = true; };
  }, [path]);
  return u;
}

function ImageBody({ shape }) {
  const u = useMedia(shape.props.path);
  const fit = shape.props.mode === 'fill' ? 'cover' : shape.props.mode === 'actual' ? 'none' : 'contain';
  if (u.state !== 'ok') return <p className="ta-node-wait" role="status">{u.state === 'reading' ? 'Reading the image…' : `Not drawn: ${u.why}.`}</p>;
  return <img className="ta-node-media" src={u.url} alt={shape.props.title} style={{ objectFit: fit }} draggable={false} />;
}

function VideoBody({ shape, onApi }) {
  const u = useMedia(shape.props.path);
  const ref = useRef(null);
  useEffect(() => { onApi({ play: () => ref.current && ref.current.play(), pause: () => ref.current && ref.current.pause() }); return () => onApi(null); }, [onApi]);
  if (u.state !== 'ok') return <p className="ta-node-wait" role="status">{u.state === 'reading' ? 'Reading the video…' : `Not played: ${u.why}.`}</p>;
  const loop = shape.props.mode === 'loop';
  return (
    <div className="ta-node-interactive" {...stopAll}>
      <video ref={ref} className="ta-node-media" src={u.url} controls={!loop} loop={loop} muted={loop} autoPlay={loop} playsInline preload="metadata" aria-label={shape.props.title} data-node-video />
    </div>
  );
}

/** A GLB in an interactive viewport: orbit (drag), zoom (wheel), Fit and Reset; solid or wireframe. */
function ModelBody({ shape, onApi }) {
  const host = useRef(null);
  const [s, setS] = useState({ state: 'reading' });
  const api = useRef(null);
  useEffect(() => {
    let gone = false; let cleanup = () => {};
    (async () => {
      try {
        const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([import('three'), import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/controls/OrbitControls.js')]);
        const bytes = await mediaBytes(shape.props.path);
        if (gone || !host.current) return;
        const el = host.current;
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        el.append(renderer.domElement);
        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xf1f3f5, 0x111316, 1.6));
        const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(3, 5, 4); scene.add(key);
        const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        const gltf = await new Promise((ok, fail) => new GLTFLoader().parse(bytes, '', ok, fail));
        if (gone) { renderer.dispose(); return; }
        const root = gltf.scene; scene.add(root);
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3()); const center = box.getCenter(new THREE.Vector3());
        const meshes = []; root.traverse((o) => { if (o.isMesh) meshes.push(o); });
        const fit = () => {
          const r = Math.max(size.x, size.y, size.z) || 1;
          camera.position.copy(center).add(new THREE.Vector3(r * 1.2, r * 0.9, r * 1.4));
          camera.near = r / 100; camera.far = r * 100; camera.updateProjectionMatrix();
          controls.target.copy(center); controls.update();
        };
        const resize = () => { const w = el.clientWidth || 1; const h = el.clientHeight || 1; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
        const ro = new ResizeObserver(resize); ro.observe(el); resize(); fit();
        let raf = 0; const tick = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(tick); }; tick();
        api.current = {
          fit, reset: fit,
          wire: (on) => { for (const m of meshes) for (const mat of [].concat(m.material)) if (mat) mat.wireframe = on; },
          facts: { meshes: meshes.length, size: [size.x, size.y, size.z].map((v) => Number(v.toFixed(3))) },
        };
        onApi(api.current);
        setS({ state: 'ok', facts: api.current.facts });
        cleanup = () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); renderer.domElement.remove(); onApi(null); };
      } catch (e) { if (!gone) setS({ state: 'failed', why: e instanceof Error ? e.message : String(e) }); }
    })();
    return () => { gone = true; cleanup(); };
  }, [shape.props.path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (api.current) api.current.wire(shape.props.mode === 'wireframe'); }, [shape.props.mode, s.state]);
  return (
    <div className="ta-node-interactive ta-node-3d" ref={host} {...stopAll} data-node-3d={s.state} aria-label={`${shape.props.title}: drag to orbit, wheel to zoom`}>
      {s.state !== 'ok' ? <p className="ta-node-wait" role="status">{s.state === 'reading' ? 'Opening the model…' : `Not opened: ${s.why}.`}</p> : null}
    </div>
  );
}

/** An app's HTML export in an isolated preview: a sandboxed frame of its own (opaque) origin, granted for a few minutes. */
function HtmlBody({ shape, onApi }) {
  const [g, setG] = useState({ state: 'asking' });
  const [text, setText] = useState(null);
  const [n, setN] = useState(0);
  useEffect(() => { onApi({ refresh: () => setN((x) => x + 1) }); return () => onApi(null); }, [onApi]);
  useEffect(() => {
    let gone = false;
    if (shape.props.mode === 'source') {
      getJson(`/api/files/file?path=${encodeURIComponent(shape.props.path)}${projectQuery('&')}`).then((r) => { if (!gone) setText(r.ok ? r.text : `Not read: ${r.error || r.status}.`); });
      return () => { gone = true; };
    }
    setG({ state: 'asking' });
    postJson(`/api/files/preview?path=${encodeURIComponent(shape.props.path)}${projectQuery('&')}`, {}).then((r) => { if (!gone) setG(r.ok ? { state: 'ok', url: r.url } : { state: 'failed', why: r.error || `the companion answered ${r.status}` }); });
    return () => { gone = true; };
  }, [shape.props.path, shape.props.mode, n]);
  if (shape.props.mode === 'source') return <pre className="ta-node-source" {...stopAll} tabIndex={0}>{text === null ? 'Reading…' : text}</pre>;
  if (g.state !== 'ok') return <p className="ta-node-wait" role="status">{g.state === 'asking' ? 'Opening the isolated preview…' : `No preview: ${g.why}.`}</p>;
  return (
    <div className="ta-node-interactive" {...stopAll}>
      <iframe className="ta-node-frame" src={g.url} title={`${shape.props.title} (isolated preview)`} sandbox="allow-scripts" referrerPolicy="no-referrer" data-node-preview />
    </div>
  );
}

/** A .riv file on the Rive runtime Timmy serves (window.TimmyRive.runtime()), its state machines' inputs as controls. */
function RiveBody({ shape, onApi }) {
  const canvas = useRef(null);
  const [s, setS] = useState({ state: 'reading' });
  const riv = useRef(null);
  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const R = window.TimmyRive;
        const rv = R && R.runtime ? await R.runtime() : null;
        if (!rv) throw new Error('the companion serves no Rive runtime here');
        const buffer = await mediaBytes(shape.props.path);
        if (gone) return;
        const probe = new rv.Rive({ buffer, canvas: canvas.current, autoplay: false, enableRiveAssetCDN: false, onLoad: () => {
          const contents = probe.contents || { artboards: [] };
          const art = contents.artboards[0];
          const sm = art && art.stateMachines && art.stateMachines[0] ? art.stateMachines[0].name : null;
          probe.cleanup();
          const r = new rv.Rive({ buffer, canvas: canvas.current, autoplay: shape.props.mode !== 'paused', enableRiveAssetCDN: false, ...(sm ? { stateMachines: sm } : {}), onLoad: () => {
            try { r.resizeDrawingSurfaceToCanvas(); } catch { /* drawn at its size */ }
            riv.current = r;
            const inputs = sm ? (r.stateMachineInputs(sm) || []).map((i) => ({ name: i.name, type: i.type, input: i })) : [];
            onApi({ play: () => r.play(), pause: () => r.pause() });
            if (!gone) setS({ state: 'ok', artboard: art ? art.name : null, sm, inputs, artboards: contents.artboards.map((a) => a.name) });
          } });
        }, onLoadError: () => { if (!gone) setS({ state: 'failed', why: 'the runtime could not read this file' }); } });
      } catch (e) { if (!gone) setS({ state: 'failed', why: e instanceof Error ? e.message : String(e) }); }
    })();
    return () => { gone = true; try { if (riv.current) riv.current.cleanup(); } catch { /* gone */ } onApi(null); };
  }, [shape.props.path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const r = riv.current; if (!r) return; if (shape.props.mode === 'paused') r.pause(); else r.play(); }, [shape.props.mode]);
  const [, force] = useState(0);
  return (
    <div className="ta-node-interactive ta-node-rive" {...stopAll} data-node-rive={s.state}>
      <canvas ref={canvas} className="ta-node-rive-canvas" aria-label={`${shape.props.title} (Rive)`} />
      {s.state !== 'ok' ? <p className="ta-node-wait" role="status">{s.state === 'reading' ? 'Loading the Rive file…' : `Not played: ${s.why}.`}</p> : (
        <div className="ta-node-rive-inputs" aria-label="State machine inputs">
          <p className="ta-node-fact">{s.artboard || 'artboard'} · {s.sm ? `state machine ${s.sm}` : 'no state machine (its timeline plays)'}</p>
          {s.inputs.map((i) => (
            <label key={i.name} className="ta-node-input">
              <span>{i.name}</span>
              {i.type === 58 ? <button type="button" className="ta-btn ta-btn-quiet" onClick={() => i.input.fire()}>Fire</button>
                : i.type === 59 ? <input type="checkbox" checked={Boolean(i.input.value)} onChange={(e) => { i.input.value = e.target.checked; force((x) => x + 1); }} />
                  : <input type="number" value={Number(i.input.value)} onChange={(e) => { i.input.value = Number(e.target.value); force((x) => x + 1); }} />}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function FileBody({ shape }) {
  const e = EXT(shape.props.path);
  return (
    <div className="ta-node-ref">
      <p className="ta-node-ref-kind">{NATIVE[e] || `.${e || 'file'}`}</p>
      <p className="ta-node-ref-path"><code>{shape.props.path}</code></p>
      <p className="ta-node-fact">Not drawn here: {appName(shape.props.app)} keeps it editable. Reopen it there; the receipt below names its bytes.</p>
    </div>
  );
}

// ── the inspector: where it came from, its parameters ───────────────────────────────────────────────────────────────────

function Inspector({ shape, extra }) {
  const [prov, setProv] = useState(null);
  useEffect(() => {
    let gone = false;
    getJson(`/api/apps/provenance?path=${encodeURIComponent(shape.props.path)}${projectQuery('&')}`).then((r) => { if (!gone) setProv(r); });
    return () => { gone = true; };
  }, [shape.props.path]);
  const p = prov && prov.ok ? prov : null;
  return (
    <div className="ta-node-inspector" {...stopAll} data-node-inspector>
      <dl className="ta-facts">
        <dt>From</dt><dd>{appName(shape.props.app)}</dd>
        <dt>File</dt><dd><code>{shape.props.path}</code></dd>
        <dt>Job</dt><dd>{p && p.receipt && p.receipt.job ? <code>{p.receipt.job}</code> : shape.props.job ? <code>{shape.props.job}</code> : 'not named'}</dd>
        <dt>Bytes</dt><dd>{p && p.sha256 ? <code title={p.sha256} data-node-sha>{p.sha256.slice(0, 16)}…</code> : prov ? prov.error || 'not read' : 'reading…'}</dd>
        <dt>Receipt</dt><dd data-node-receipt>{p && p.receipt ? <><code>{p.receipt.id}</code> ({p.receipt.kind}, these bytes)</> : p ? 'no receipt names these bytes' : shape.props.receipt ? <code>{shape.props.receipt}</code> : 'reading…'}</dd>
        {p && p.sent && p.sent.length ? <><dt>Sent to</dt><dd>{p.sent.map((x) => `${appName(x.app)} run ${x.run} (receipt ${x.receipt})`).join('; ')}</dd></> : null}
        {extra}
      </dl>
    </div>
  );
}

// ── the node ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PRIMARY = {
  image: (shape) => ({ label: 'Send to Image Analysis', run: async () => {
    const r = await postJson(`/api/apps/card-lab/handoff${projectQuery()}`, { path: shape.props.path });
    say(r.ok ? `Sent to Image Analysis: run ${r.run}${r.receipt ? ` (handoff receipt ${String(r.receipt).slice(0, 12)})` : ''}.` : `Not sent: ${r.error || r.status}.`);
  } }),
  video: (shape) => ({ label: 'Open in Video Breakdown', run: () => openApp('film-room') }),
  model: () => ({ label: 'Open in 3D Model Studio', run: () => openApp('model-studio') }),
  html: (shape) => ({ label: `Open in ${appName(shape.props.app)}`, run: () => openApp(shape.props.app) }),
  rive: (shape) => ({ label: `Open in ${appName(shape.props.app)}`, run: () => openApp(shape.props.app) }),
  file: (shape) => ({ label: `Reopen in ${appName(shape.props.app)}`, run: () => openApp(shape.props.app) }),
};

function DisplayNode({ shape, editor }) {
  const kind = KINDS[shape.props.kind] ? shape.props.kind : 'file';
  const def = KINDS[kind];
  const [api, setApi] = useState(null);
  const onApi = useMemo(() => (a) => setApi(a), []);
  const set = (props) => editor.updateShape({ id: shape.id, type: DISPLAY_SHAPE, props });
  const primary = PRIMARY[kind](shape);
  const mode = def.modes.find(([m]) => m === shape.props.mode) || def.modes[0];
  const Body = { image: ImageBody, video: VideoBody, model: ModelBody, html: HtmlBody, rive: RiveBody, file: FileBody }[kind];
  return (
    <div className="ta-node" data-node-kind={kind} data-node-path={shape.props.path}>
      <header className="ta-node-head">
        <span className="ta-node-kind">{def.word}</span>
        <strong className="ta-node-title" title={shape.props.title}>{shape.props.title}</strong>
        <span className="ta-node-status">{appName(shape.props.app)}</span>
        {def.modes.length > 1 ? (
          <MenuButton label={mode[1]} title="View" menuLabel={`${shape.props.title}: view`} buttonClass="ta-node-btn" data={{ 'data-menu': 'node-view' }}>
            {(close) => <MenuGroup label="View">{def.modes.map(([m, w]) => <MenuItem key={m} checked={m === mode[0]} close={close} onSelect={() => set({ mode: m })} data={{ 'data-view': m }}>{w}</MenuItem>)}</MenuGroup>}
          </MenuButton>
        ) : null}
        <MenuButton label="Actions" glyph="⋯" title="Actions" menuLabel={`${shape.props.title}: actions`} buttonClass="ta-node-btn is-icon" data={{ 'data-menu': 'node-actions' }}>
          {(close) => (
            <>
              <MenuGroup label="This node">
                {kind === 'model' ? <><MenuItem close={close} disabled={!api} onSelect={() => api.fit()} data={{ 'data-act': 'fit' }}>Fit the model</MenuItem><MenuItem close={close} disabled={!api} onSelect={() => api.reset()} data={{ 'data-act': 'reset' }}>Reset the view</MenuItem></> : null}
                {kind === 'video' || kind === 'rive' ? <><MenuItem close={close} disabled={!api} onSelect={() => api.play()} data={{ 'data-act': 'play' }}>Play</MenuItem><MenuItem close={close} disabled={!api} onSelect={() => api.pause()} data={{ 'data-act': 'pause' }}>Pause</MenuItem></> : null}
                {kind === 'html' ? <MenuItem close={close} disabled={!api} onSelect={() => api.refresh()} data={{ 'data-act': 'refresh' }}>Reload the preview</MenuItem> : null}
                <MenuItem close={close} onSelect={() => set({ panel: !shape.props.panel })} data={{ 'data-act': 'inspector' }}>{shape.props.panel ? 'Hide the inspector' : 'Show the inspector'}</MenuItem>
              </MenuGroup>
              <MenuGroup label="Its source">
                <MenuItem close={close} onSelect={() => openApp(shape.props.app)} data={{ 'data-act': 'reopen' }} hint="its editable source and revisions">Reopen in {appName(shape.props.app)}</MenuItem>
                <MenuItem close={close} onSelect={() => showInFiles(shape.props.path)} data={{ 'data-act': 'files' }}>Show in Files</MenuItem>
                <MenuItem close={close} onSelect={() => aimAgent({ kind: 'app', app: shape.props.app, path: shape.props.path })} data={{ 'data-act': 'agent' }}>Send to an agent</MenuItem>
              </MenuGroup>
              <MenuGroup label="Canvas">
                <MenuItem close={close} onSelect={() => editor.deleteShape(shape.id)} data={{ 'data-act': 'delete' }}>Remove from this board</MenuItem>
              </MenuGroup>
            </>
          )}
        </MenuButton>
      </header>
      <div className="ta-node-body"><Body shape={shape} onApi={onApi} /></div>
      {shape.props.panel ? <Inspector shape={shape} extra={kind === 'model' && api && api.facts ? <><dt>Meshes</dt><dd>{api.facts.meshes}</dd><dt>Size (model units)</dt><dd>{api.facts.size.join(' × ')}</dd></> : null} /> : null}
      <footer className="ta-node-foot" {...stopAll}>
        <button type="button" className="ta-btn ta-btn-primary ta-node-primary" onClick={() => primary.run()} data-node-primary>{primary.label}</button>
        <button type="button" className="ta-node-toggle" aria-expanded={Boolean(shape.props.panel)} onClick={() => set({ panel: !shape.props.panel })} data-node-toggle>{shape.props.panel ? 'Less' : 'Source · receipt'}</button>
      </footer>
    </div>
  );
}

/** The display node's shape (a box: resized by its corners; bound by arrows like any card). */
export function createDisplayUtil(editorOf) {
  return class DisplayUtil extends BaseBoxShapeUtil {
    static type = DISPLAY_SHAPE;
    static props = { w: T.number, h: T.number, kind: T.string, title: T.string, path: T.string, app: T.string, receipt: T.string, job: T.string, mode: T.string, panel: T.boolean };
    getDefaultProps() { return { w: 360, h: 300, kind: 'file', title: '', path: '', app: '', receipt: '', job: '', mode: '', panel: false }; }
    hideRotateHandle() { return true; }
    canEdit() { return false; }
    canBind() { return true; }
    onResize(shape, info) { const n = resizeBox(shape, info); return { ...n, props: { ...n.props, w: Math.max(240, n.props.w), h: Math.max(200, n.props.h) } }; }
    getText(shape) { return shape.props.title; }
    component(shape) {
      return <HTMLContainer className="ta-node-shape" style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}><DisplayNode shape={shape} editor={editorOf()} /></HTMLContainer>;
    }
    getIndicatorPath(shape) { const p = new Path2D(); p.roundRect(0, 0, shape.props.w, shape.props.h, 14); return p; }
  };
}

/** The size a new node of a kind is made at (page units). */
export const NODE_SIZE = Object.freeze({ image: [340, 300], video: [400, 300], model: [380, 340], html: [420, 340], rive: [360, 360], file: [320, 220] });
