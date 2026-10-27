// The 07:37 completion pass, on the operator's 08:10 word: the Canvas as the one workspace that takes in what every app made.
// "Import from apps" lists the apps' delivered results (GET /api/apps/outputs: each job's files under from-apps/<app>/<job>/,
// with the receipt that sealed them) and places one on the licensed tldraw desk as a real node:
//   - an image (png, jpg, webp, gif, svg): a tldraw image whose asset points at the project file (asset:timmy-file/<path>);
//   - a video (mp4, webm, mov): a tldraw video the same way;
//   - anything else (a mesh, a scene, a native Rive or CAD file, an HTML player): a note naming it, its app and its receipt
//     (a mesh shows as its own app's preview, never as measured geometry here).
// Each node's meta keeps where it came from (app, path, receipt), so the desk's arrows can wire it into a workflow and the
// file it stands for stays the receipted one. The asset store reads a timmy-file: asset's bytes through the companion with
// the page's token when the desk draws it (an object URL for this page only); the saved desk keeps only the path.
import { useEffect, useRef, useState } from 'react';
import { AssetRecordType, createShapeId, toRichText } from 'tldraw';
import { call, getJson } from '../api.js';
import { projectQuery } from '../store.js';

// tldraw accepts an asset src of http(s), data, blob or asset: — an imported result is asset:timmy-file/<project path>
export const FILE_SRC = 'asset:timmy-file/';
const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };
const APP_WORDS = { 'card-lab': 'Card Lab', 'film-room': 'Film Room', 'model-studio': 'Model Studio', 'stream-studio': 'Stream Studio', animate: 'Animate' };
const ext = (p) => (/\.([a-z0-9]+)$/i.exec(p) || [])[1]?.toLowerCase() || '';

/** What a delivered file becomes on the desk. */
export function nodeKindOf(path) { return IMAGE.test(path) ? 'image' : VIDEO.test(path) ? 'video' : 'note'; }

const urls = new Map();
/** The bytes of a project file as an object URL for this page (fetched once with the page's token). */
async function fileUrl(path) {
  if (urls.has(path)) return urls.get(path);
  const p = (async () => {
    const r = await call(`/api/files/file?path=${encodeURIComponent(path)}${projectQuery('&')}`);
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

/** The size an image or video draws at, read from its bytes (bounded to 480 units on its long side). */
async function sizeOf(kind, url) {
  const natural = await new Promise((ok) => {
    if (kind === 'image') { const i = new Image(); i.onload = () => ok({ w: i.naturalWidth || 320, h: i.naturalHeight || 240 }); i.onerror = () => ok({ w: 320, h: 240 }); i.src = url; }
    else { const v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = () => ok({ w: v.videoWidth || 480, h: v.videoHeight || 270 }); v.onerror = () => ok({ w: 480, h: 270 }); v.src = url; }
  });
  const k = Math.min(1, 480 / Math.max(natural.w, natural.h));
  return { w: Math.round(natural.w * k), h: Math.round(natural.h * k) };
}

/** Place one app result on the desk at the viewport's centre; returns the new shape's id. */
export async function importOutput(editor, file, result) {
  const kind = nodeKindOf(file.path);
  const meta = { from: 'app-output', app: result.app, path: file.path, receipt: result.receipt || null };
  const c = editor.getViewportPageBounds().center;
  const id = createShapeId();
  if (kind === 'note') {
    const words = `${APP_WORDS[result.app] || result.app} · ${file.name}\n${file.path}${result.receipt ? `\nreceipt ${result.receipt}` : ''}\nOpen it in ${APP_WORDS[result.app] || result.app} to edit it.`;
    editor.run(() => { editor.createShape({ id, type: 'note', x: c.x - 100, y: c.y - 100, meta, props: { richText: toRichText(words), size: 's', scale: 0.8 } }); editor.select(id); });
    return id;
  }
  const url = await fileUrl(file.path);
  const { w, h } = await sizeOf(kind, url);
  const assetId = AssetRecordType.createId();
  editor.run(() => {
    editor.createAssets([{ id: assetId, typeName: 'asset', type: kind, meta, props: { name: file.name, src: `${FILE_SRC}${file.path}`, w, h, mimeType: MIME[ext(file.path)] || null, isAnimated: kind === 'video' || ext(file.path) === 'gif' } }]);
    editor.createShape({ id, type: kind, x: c.x - w / 2, y: c.y - h / 2, meta, props: { assetId, w, h } });
    editor.select(id);
  });
  return id;
}

/** The desk's "Import from apps" menu: the apps' newest results, each file a choice. */
export function ImportMenu({ editor }) {
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
    try { await importOutput(editor, file, result); setOpen(false); } catch (e) { setNote(`Not placed: ${e instanceof Error ? e.message : String(e)}.`); }
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
                        <span className="ta-tool-glyph" aria-hidden="true">{nodeKindOf(f.path) === 'image' ? '▧' : nodeKindOf(f.path) === 'video' ? '▶' : '◇'}</span>{f.name}
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
