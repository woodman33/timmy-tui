// The 07:37 completion pass, on the operator's 08:10 word, and the unified Workspace order (2026-10-27): the Workspace takes in
// what every app made. "Import from apps" lists the apps' delivered results (GET /api/apps/outputs: each job's files under
// from-apps/<app>/<job>/, with the receipt that sealed them) and places each as a Timmy display node (./display-node.jsx):
// an image, a video, an interactive 3D model (GLB), an isolated HTML preview, a Rive file on the Rive runtime, or a reference
// to a native/source file (a mesh's .blend, a scene, CAD source) with its Reopen action — never shown as measured geometry.
// Images and videos placed by an earlier build stay tldraw images and videos whose asset points at the project file
// (asset:timmy-file/<path>): the asset store below still draws them.
import { APP_NAMES } from '../app-names.js';
import { useEffect, useRef, useState } from 'react';
import { createShapeId } from 'tldraw';
import { call, getJson } from '../api.js';
import { projectQuery } from '../store.js';
import { DISPLAY_SHAPE, KINDS, NODE_SIZE, displayKindOf, mediaUrl } from './display-node.jsx';

// tldraw accepts an asset src of http(s), data, blob or asset: — an imported result is asset:timmy-file/<project path>
export const FILE_SRC = 'asset:timmy-file/';
const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };
const APP_WORDS = APP_NAMES;
const ext = (p) => (/\.([a-z0-9]+)$/i.exec(p) || [])[1]?.toLowerCase() || '';

/** What a delivered file becomes on the desk. */
export function nodeKindOf(path) { return IMAGE.test(path) ? 'image' : VIDEO.test(path) ? 'video' : 'note'; }

const urls = new Map();
/** The bytes of a project file as an object URL for this page (fetched once with the page's token). */
async function fileUrl(path) {
  if (urls.has(path)) return urls.get(path);
  const p = (async () => {
    const r = await call(`/api/files/media?path=${encodeURIComponent(path)}${projectQuery('&')}`);
    if (!r.ok) throw new Error(`the companion answered ${r.status}`);
    return URL.createObjectURL(await r.blob());
  })();
  urls.set(path, p);
  p.catch(() => urls.delete(path));
  return p;
}

/**
 * The desk's asset store: a file dropped or pasted on the desk is kept in the desk as before (a data URL); an imported app
 * result is read from the project when drawn.
 */
export const ASSET_STORE = {
  async upload(_asset, file) {
    const src = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => fail(r.error); r.readAsDataURL(file); });
    return { src };
  },
  async resolve(asset) {
    const src = asset && asset.props ? asset.props.src : null;
    if (typeof src !== 'string' || !src.startsWith(FILE_SRC)) return src || null;
    try { return await fileUrl(src.slice(FILE_SRC.length)); } catch { return null; }
  },
};

/**
 * A free place for a w × h node: the desk's own free-space finder first (`place`), else the next free place to the right of
 * everything on the board that is not an imported node, along the desk's rows (the camera pans along them, and the desk's
 * bounds grow to hold it); `near` (page coordinates) is tried first when given. Never on top of another shape.
 */
export function placeOnBoard(editor, w, h, place = null, c = null, near = null) {
  const taken = editor.getCurrentPageShapes().filter((x) => x.type !== 'arrow').map((x) => editor.getShapePageBounds(x.id)).filter(Boolean);
  const clear = (q) => q && !taken.some((b) => q.x < b.x + b.w + 16 && q.x + w + 16 > b.x && q.y < b.y + b.h + 16 && q.y + h + 16 > b.y);
  if (near) for (let dy = 0; dy <= 1200; dy += 20) { const q = { x: near.x, y: near.y + dy }; if (clear(q)) return q; }
  const p = place ? place(w, h) : null;
  if (clear(p)) return p;
  const base = editor.getCurrentPageShapes().filter((x) => x.type !== DISPLAY_SHAPE && x.type !== 'timmy-op' && x.type !== 'arrow').map((x) => editor.getShapePageBounds(x.id)).filter(Boolean);
  const all = base.length ? base.reduce((a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), r: Math.max(a.r, b.x + b.w), b: Math.max(a.b, b.y + b.h) }), { x: Infinity, y: Infinity, r: -Infinity, b: -Infinity }) : null;
  const center = c || editor.getViewportPageBounds().center;
  if (!all) return { x: center.x - w / 2, y: center.y - h / 2 };
  const top = Math.min(all.y, 0); const bottom = Math.max(all.b, top + h);
  for (let x = all.r + 40; x < all.r + 40 + 60 * (w + 40); x += 20) for (let y = top; y + h <= bottom; y += 20) if (clear({ x, y })) return { x, y };
  return { x: all.r + 40, y: top };
}

/**
 * Place one app result on the board where it has room (`place`: the desk's own free-space finder), as a Timmy display node
 * (./display-node.jsx): an image, a video, a 3D model, an HTML or Rive preview, or a reference to a native/source file — each
 * with the node's header, view and actions, its inspector and its primary action. Its meta keeps where it came from.
 */
export async function importOutput(editor, file, result, place = null, focus = null, hold = null) {
  const kind = displayKindOf(file.path);
  const meta = { from: 'app-output', app: result.app, path: file.path, receipt: result.receipt || null };
  const c = editor.getViewportPageBounds().center;
  let [w, h] = NODE_SIZE[kind] || NODE_SIZE.file;
  // an image keeps its own proportions (read from its bytes; at most 360 units on its long side, plus the node's header and foot)
  if (kind === 'image') {
    try {
      const url = await mediaUrl(file.path);
      const n = await new Promise((ok) => { const i = new Image(); i.onload = () => ok({ w: i.naturalWidth || 320, h: i.naturalHeight || 240 }); i.onerror = () => ok({ w: 320, h: 240 }); i.src = url; });
      const k = Math.min(1, 360 / Math.max(n.w, n.h));
      w = Math.max(260, Math.round(n.w * k)); h = Math.round(n.h * k) + 96;
    } catch { /* the default size */ }
  }
  const at = () => ({ ...placeOnBoard(editor, w, h, place, c), w, h });
  const id = createShapeId();
  const p = at();
  editor.run(() => {
    editor.createShape({ id, type: DISPLAY_SHAPE, x: p.x, y: p.y, meta, props: { w, h, kind, title: file.name, path: file.path, app: result.app, receipt: result.receipt || '', job: result.job || '', mode: (KINDS[kind] || KINDS.file).modes[0][0], panel: false } });
    editor.select(id);
  });
  if (hold) hold(editor);
  if (focus) focus(editor, id);
  return id;
}

/** The desk's "Import from apps" menu: the apps' newest results, each file a choice. */
export function ImportMenu({ editor, place = null, focus = null, hold = null }) {
  const [open, setOpen] = useState(false);
  const [r, setR] = useState(null);
  const [note, setNote] = useState('');
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    let gone = false;
    setR(null); setNote('');
    getJson(`/api/apps/outputs${projectQuery()}`).then((x) => { if (!gone) setR(x); });
    const off = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', off);
    document.addEventListener('keydown', esc);
    return () => { gone = true; document.removeEventListener('pointerdown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  const pick = async (file, result) => {
    try { await importOutput(editor, file, result, place, focus, hold); setOpen(false); } catch (e) { setNote(`Not placed: ${e instanceof Error ? e.message : String(e)}.`); }
  };
  const results = r && r.ok ? r.results || [] : [];
  return (
    <div className="ta-menu-wrap" ref={box}>
      <button type="button" className="ta-tool" aria-haspopup="menu" aria-expanded={open} disabled={!editor} onClick={() => setOpen(!open)} data-tool="Import">
        <span className="ta-tool-glyph" aria-hidden="true">⇩</span><span className="ta-tool-label">Import from apps</span>
      </button>
      {open && editor ? (
        <div className="ta-popover ta-import" role="menu" aria-label="Import an app's result onto the desk">
          {!r ? <p className="ta-muted ta-pad">Reading the apps’ results…</p>
            : !r.ok ? <p className="ta-muted ta-pad">{r.error || 'The companion did not answer.'}</p>
              : !results.length ? <p className="ta-muted ta-pad">No app has delivered a result to this project yet.</p>
                : results.slice(0, 12).map((x) => (
                  <div key={x.receipt || `${x.app}${x.at}`} className="ta-import-group" role="group" aria-label={`${APP_WORDS[x.app] || x.app} · ${x.label || 'job'}`}>
                    <p className="ta-context-k">{(APP_WORDS[x.app] || x.app).toUpperCase()} · {x.label || 'job'}</p>
                    {x.files.slice(0, 8).map((f) => (
                      <button key={f.path} type="button" role="menuitem" className="ta-popover-item" data-import={f.path} onClick={() => pick(f, x)}>
                        <span className="ta-tool-glyph" aria-hidden="true">{({ image: '▧', video: '▶', model: '◭', html: '⧉', rive: '◎' })[displayKindOf(f.path)] || '◇'}</span>{f.name}
                      </button>
                    ))}
                  </div>
                ))}
          {note ? <p className="ta-result" role="status">{note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
