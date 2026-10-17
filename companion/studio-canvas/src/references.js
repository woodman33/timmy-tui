// R6 (H145): reference images on a project's board, from the project's own files only (reference 06; the operator's order of
// 2026-10-16). The side panel's "Reference images" lists the shown project's images (GET /api/project/reference-files,
// src/studio/references.ts); "Add to the board" asks Timmy to copy one into the board's own folder (POST /api/project/reference:
// read through one descriptor, raster only, never an SVG, never through a link, nothing written into the project's folder) and
// puts it on the board as a tldraw image, captioned with its file name and where it came from. Its asset keeps in its meta what it
// is: { path (project-relative), sha256, bytes, from, project }.
//
// The image is shown from the board's own copy (GET /api/canvas/ref/<project>/<sha256>.<ext>), read with this page's session and
// handed to tldraw as an object URL by the board's asset store (`resolve`): never with a credential in an address, and only for
// the project whose board is on screen (an image of another project, pasted onto this board, is not shown). Draft rules apply as
// to any shape: placed by Timmy's own call, its asset and shapes carry the draft's mark (canvas.js), and Discard removes them.
// While Studio switches boards nothing is added; a copy answered after a switch places nothing on either board (it stays in its
// own board's folder) and the "Kept apart" log says so. Every text is set as text. Imports nothing, so its pure part runs in Node.

/** Where a reference's asset keeps what it is (its meta). */
export const REF_META = 'timmyRef';
/** A caption's meta: the asset it names. */
export const CAPTION_META = 'timmyRefCaption';
/** The board's copy, as an asset's src names it: /api/canvas/ref/<project id>/<sha256>.<ext>. */
export const REF_SRC = /^\/api\/canvas\/ref\/([0-9a-f]{16})\/([0-9a-f]{64})\.(png|jpg|gif|webp)$/;
/** The widest a reference image is placed at first (page units); the person's to change. */
export const REF_PLACE_W = 360;

const one = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** A reference asset's src parts (its project, sha256 and type), or null when it is not a board copy. */
export function refOfSrc(src) {
  const m = REF_SRC.exec(String(src ?? ''));
  return m ? { project: m[1], sha256: m[2], ext: m[3], file: `${m[2]}.${m[3]}` } : null;
}

/** A size in words. */
export const bytesWords = (n) => (!Number.isFinite(n) ? 'size not known' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** What a reference's asset keeps in its meta, from Timmy's answer to the copy. */
export function refMeta(ref, project) {
  return { path: String(ref.path), sha256: String(ref.sha256), bytes: Number(ref.bytes), from: one(ref.from), project: String(project.id), projectName: one(project.name).slice(0, 120) };
}

/** The caption under a reference image: its file name, where it came from, its sha256 and size. */
export const captionText = (meta) => `${meta.path.split('/').pop()} · from ${meta.path} in ${meta.projectName || 'its project'} · sha256 ${meta.sha256.slice(0, 12)} · ${bytesWords(meta.bytes)}`;

/** The size a reference is placed at: its own, scaled down to REF_PLACE_W wide when wider. */
export function placedSize(w, h) {
  const W = Number.isFinite(w) && w > 0 ? w : REF_PLACE_W;
  const H = Number.isFinite(h) && h > 0 ? h : REF_PLACE_W;
  const k = W > REF_PLACE_W ? REF_PLACE_W / W : 1;
  return { w: Math.round(W * k), h: Math.round(H * k) };
}

/** The words a refused add says while Studio switches (or shows no board). */
export function notNowWords(scope) {
  if (scope && scope.state === 'switching') return `Not added: Studio is switching to ${scope.switching ? scope.switching.name : 'another project'}, so nothing is added to either board until its board is loaded.`;
  if (scope && scope.state === 'paused') return `Not added: ${one(scope.paused) || 'the canvas shows a project this page cannot show.'}`;
  return 'Not added: no board is on screen yet.';
}

// ── the asset store, the list and the add (the browser only) ──────────────────────────────────────────────────────────

/**
 * `deps`: editor(); scope() (the board on screen); ticket() and current(ticket) (./identity.js); kept(project, detail) (a "Kept apart"
 * line); files(projectId), copy(projectId, path) and image(projectId, file) (./cards.js: with this page's session, never handed out);
 * forget(url); AssetRecordType and createShapeId (tldraw); place(editor, size) and reveal(editor, ids); say(text, bad) (the band).
 */
export function createReferences(deps) {
  /** The object URL of each board copy read for the board on screen, by its src (let go when Studio leaves that board). */
  const shown = new Map();
  /** For the tests and the panel: the last add's answer (what was copied, or why not). */
  let last = null;

  /**
   * tldraw's asset store for the board (the Tldraw component's `assets`): a board copy is read with this page's session and shown
   * from memory, for the board on screen's project only; any other asset as tldraw keeps it (its own upload stays its inline one).
   */
  function assetStore(base) {
    return {
      upload: (asset, file, signal) => base.upload(asset, file, signal),
      remove: base.remove ? (ids) => base.remove(ids) : undefined,
      resolve(asset, ctx) {
        const src = asset && asset.props ? asset.props.src : null;
        const ref = refOfSrc(src);
        if (!ref) return base.resolve ? base.resolve(asset, ctx) : src;
        const sc = deps.scope();
        if (sc.state !== 'shown' || !sc.project || sc.project.id !== ref.project) return null;
        const have = shown.get(src);
        if (have) return have;
        const ticket = deps.ticket();
        const p = deps.image(ref.project, ref.file).then((url) => {
          if (!url) { shown.delete(src); return null; }
          if (!deps.current(ticket)) { deps.forget(url); shown.delete(src); return null; }
          shown.set(src, url);
          return url;
        }, () => { shown.delete(src); return null; });
        shown.set(src, p);
        return p;
      },
    };
  }

  /** Studio left the board (a switch, a pause): every copy it showed is let go. */
  function scopeChanged() {
    for (const [src, url] of shown) { if (typeof url === 'string') deps.forget(url); shown.delete(src); }
    void poll();
  }

  /** The size of the copy, read from the image itself (null when it cannot be read). */
  function sizeOf(url) {
    return new Promise((done) => {
      const img = new Image();
      img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => done(null);
      img.src = url;
    });
  }

  /**
   * Adds the project's image at `path` to the board on screen: Timmy copies it into the board's folder, then the image and its
   * caption are put on the board, grouped (one undo step). Refused while Studio switches; a copy answered after a switch places
   * nothing on either board.
   */
  async function add(path) {
    const sc = deps.scope();
    if (sc.state !== 'shown' || !sc.project) throw new Error(notNowWords(sc));
    const ticket = deps.ticket();
    const r = await deps.copy(ticket.project, String(path));
    const b = (r && r.body) || {};
    last = b;
    if (!deps.current(ticket)) {
      if (r && r.ok && b.ok === true) deps.kept(b.project || sc.project, `its reference image ${one(path)}, copied into its own board's folder`);
      throw new Error(`Not added: Studio switched boards while Timmy copied ${one(path)}, so nothing was placed on either board (the copy stays in ${sc.project.name}'s own board folder).`);
    }
    if (!(r && r.ok && b.ok === true && b.ref && b.project && b.project.id === ticket.project)) throw new Error(one(b.error) || `Not added: Timmy answered ${r ? r.status : 0}.`);
    const ref = b.ref;
    const editor = deps.editor();
    const meta = refMeta(ref, b.project);
    // its size, from the copy itself (read with the session)
    const url = await deps.image(ticket.project, `${ref.sha256}.${ref.ext}`);
    const size = url ? await sizeOf(url) : null;
    if (url) deps.forget(url);
    if (!editor || !deps.current(ticket)) throw new Error(`Not added: Studio switched boards while it read ${one(path)}, so nothing was placed on either board.`);
    const assetId = deps.AssetRecordType.createId(ref.sha256);
    // one step of tldraw's undo: the asset (when new), the image and its caption, grouped
    editor.markHistoryStoppingPoint(`timmy reference ${ref.sha256.slice(0, 8)}`);
    if (!editor.getAsset(assetId)) {
      editor.createAssets([{
        id: assetId, typeName: 'asset', type: 'image',
        props: { name: ref.name, src: ref.src, w: size ? size.w : REF_PLACE_W, h: size ? size.h : REF_PLACE_W, mimeType: ref.mime, isAnimated: ref.ext === 'gif', fileSize: ref.bytes },
        meta: { [REF_META]: meta },
      }]);
    }
    const dims = placedSize(size ? size.w : null, size ? size.h : null);
    // beside the reference images and Timmy's cards already on this page (right of the rightmost), so one never covers another
    const others = editor.getCurrentPageShapes().filter((x) => (x.meta && (x.meta[REF_META] || x.meta[CAPTION_META])) || /^timmy-/.test(x.type)).map((x) => editor.getShapePageBounds(x.id)).filter(Boolean);
    const right = others.reduce((a, x) => (!a || x.maxX > a.maxX ? x : a), null);
    const at = right ? { x: Math.round(right.maxX + 32), y: Math.round(right.minY) } : deps.place(editor, { w: REF_PLACE_W, h: REF_PLACE_W });
    const image = deps.createShapeId();
    const caption = deps.createShapeId();
    editor.createShapes([
      { id: image, type: 'image', x: at.x, y: at.y, props: { assetId, w: dims.w, h: dims.h, altText: captionText(meta) }, meta: { [REF_META]: { sha256: ref.sha256, path: ref.path } } },
      { id: caption, type: 'text', x: at.x, y: at.y + dims.h + 8, props: { richText: deps.toRichText(captionText(meta)), size: 's', font: 'mono', autoSize: false, w: Math.max(dims.w, REF_PLACE_W) }, meta: { [CAPTION_META]: { asset: assetId, sha256: ref.sha256 } } },
    ]);
    editor.groupShapes([image, caption]);
    const group = editor.getShape(image)?.parentId ?? image;
    if (editor.getShape(group)) editor.select(group);
    try { deps.reveal(editor, [image, caption]); } catch { /* showing it is a courtesy */ }
    return { added: true, image, caption, group, asset: assetId, ref, project: b.project.name, copied: b.copied === true };
  }

  // ── the side panel's list ──
  const el = (tag, text, o = {}) => Object.assign(document.createElement(tag), text === undefined ? {} : { textContent: text }, o);
  let sig = '';
  async function poll() {
    const box = document.getElementById('references');
    if (!box) return;
    const name = document.getElementById('references-name');
    const list = document.getElementById('reference-list');
    const sc = deps.scope();
    if (sc.state !== 'shown' || !sc.project) { name.textContent = sc.state === 'switching' ? `switching to ${sc.switching ? sc.switching.name : 'another project'}…` : 'not shown now'; list.replaceChildren(); sig = ''; return; }
    const ticket = deps.ticket();
    let r;
    try { r = await deps.files(ticket.project); } catch { r = null; }
    if (!deps.current(ticket)) { if (r && r.ok && r.body && r.body.ok) deps.kept(r.body.project, 'its image files'); return; }
    const b = (r && r.body) || {};
    const now = JSON.stringify([b.project, b.files, b.more, b.error]);
    if (now === sig) return;
    sig = now;
    if (!(r && r.ok && b.ok === true)) { name.textContent = 'not read'; list.replaceChildren(el('li', one(b.error) || 'The project\'s images could not be read.', { className: 'ritem-empty' })); return; }
    name.textContent = `${b.project.name} · ${b.files.length}${b.more ? ` (+${b.more})` : ''}`;
    list.replaceChildren(...(b.files.length ? b.files.map((f) => {
      const li = el('li', undefined, { className: 'ritem' });
      li.dataset.path = f.path;
      li.dataset.project = b.project.id;
      li.append(el('span', f.path, { className: 'ritem-path' }), ' ', el('span', bytesWords(f.bytes), { className: 'ritem-size' }));
      const put = el('button', 'Add to the board', { type: 'button', className: 'ritem-add', title: `Copies ${f.path} into ${b.project.name}'s board folder and puts it on the board, captioned (nothing is written into the project's folder)` });
      put.addEventListener('click', () => {
        put.disabled = true;
        add(f.path).then((x) => deps.say(`Added to ${x.project}'s board: ${x.ref.path} (sha256 ${x.ref.sha256.slice(0, 12)}, ${bytesWords(x.ref.bytes)}), copied into its board folder.`), (e) => deps.say(e instanceof Error ? e.message : String(e), true)).finally(() => { put.disabled = false; });
      });
      li.append(put);
      return li;
    }) : [el('li', `No PNG, JPEG, WebP or GIF files in ${b.project.name}.`, { className: 'ritem-empty' })]));
  }
  function connect() {
    const next = () => setTimeout(() => { const go = document.visibilityState === 'visible' ? poll() : Promise.resolve(); go.finally(next); }, 8000);
    void poll().finally(next);
  }

  return { assetStore, add, poll, connect, scopeChanged, last: () => last };
}
