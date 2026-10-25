// R6 (H145): the shown project's artifacts on Timmy Studio's board (reference 06; the operator's order of 2026-10-16: "Studio
// reference images, custom nodes and project-linked artifacts … a working artifact-to-preview-to-action journey"). The side panel
// lists the project's artifacts (Artifacts: its VoxVision records, its runs and its receipts, read by Timmy's own readers through
// GET /api/project/artifacts, src/studio/artifacts.ts); "Place on the board" puts one on the board as an artifact card that SHOWS
// the artifact and OPENS its preview, with one action:
//
//   kind     the card shows                                                 Open preview opens
//   vox      the observed image, with what was measured over it (boxes,     Studio's VoxVision preview, in the side panel: every
//            polygons, points, each labelled provenance · evidence), and    image with its overlays, the values and the receipt
//            its receipt (✓ green only when it verifies now)                (the companion's tab 5 has the record in full: said)
//   run      the operation's outputs and receipts, as its one run detail    its run detail, in the side panel (./run-detail.js)
//            says them (src/ops/run-detail.ts, never computed here)
//   receipt  its kind, subject and status, and whether it verifies now      Studio's receipt page (/receipts/<id>)
//
// Nothing an artifact card shows is kept in the board but its name (its project, its title, and what its last reading said in
// words): the image is read with this page's session and shown from memory (an object URL), and the green verified mark is drawn
// only from a reading made now, never from a kept one. A card shows its artifact only while its project's board is on screen
// (R6 H139, ./identity.js): on another project's board (a card pasted there), while Studio switches boards, or while the canvas
// shows a project this page cannot show, it names its project and shows nothing of it. Readings and placements record whose board
// was on screen when they were asked; one that comes back after a switch is dropped (nothing is placed on either board) and the
// "Kept apart" log says so.
//
// Every text is set as text (React escapes it); nothing is markup. Imports only ./when.js (the one time format, which imports
// nothing) and (R10 H167) ./face.js (the face's words, which imports nothing), so Node's tests run the pure part too.
import { clockOf, dateTimeOf } from './when.js';
// R10 (H167): what the face says of a record (no id, hash or place: those are in its Details or its tip)
import { faceTitle, faceWords } from './face.js';

/** The artifact card's tldraw shape type (src/studio/canvas-auth.ts DRAWN_CARD_TYPES names it: another project's is withheld). */
export const ARTIFACT_SHAPE = 'timmy-artifact';
export const ARTIFACT_KINDS = ['vox', 'run', 'receipt'];
/** An artifact's id, as the list names it and a placed card keeps it. */
export const ARTIFACT_ID = /^(?:vox:v[0-9a-f]{8}|run:o[0-9a-f]{8}|receipt:[0-9a-f]{8})$/;
const PROJECT_ID = /^[0-9a-f]{16}$/;
export const KIND_WORDS = { vox: 'VoxVision record', run: 'Run', receipt: 'Receipt' };
/** The card's width (the person's to change; its height follows its content). */
export const ARTIFACT_WIDTH = 360;
/** R7 (H151): the height an artifact card is placed with in mind (it then fits its content; canvas.js keepClear moves one that grew over a shape). */
export const ARTIFACT_PLACE_H = 320;
/** What Open preview says it opens, per kind. */
export const OPENS = { vox: 'Open preview', run: 'Open run detail', receipt: 'Open receipt page' };
/** Where the companion's tab 5 shows a VoxVision record in full (this page cannot hold the companion's token: ./frame.js). */
export const COMPANION_VOX = (id) => `The companion's tab 5 shows this record in full (its entity tree, frames, pipeline and engines): in the Workbench, 5, select ${id}, then c.`;

const one = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const cut = (v, max) => { const c = Array.from(one(v)); return c.length > max ? `${c.slice(0, max - 1).join('')}…` : c.join(''); };

/** The typed command that shows an artifact in Timmy (the REPL), per kind. */
export function artifactCommand(row) {
  if (!row || typeof row.id !== 'string') return '';
  if (row.kind === 'run' && row.preview && row.preview.op) return `/op ${row.preview.op}`;
  if (row.kind === 'vox' && typeof row.record === 'string' && row.record) return `/open ${row.record}`;
  if (row.kind === 'receipt' && row.receipt && row.receipt.short) return `/web ${row.receipt.short}`;
  return '';
}

/**
 * What a placed card keeps of a list row: its name and its last reading in words. Never the image, never a verified mark (the
 * mark is drawn from a reading made now), never the preview's content.
 */
export function artifactProps(row, project, now = new Date()) {
  return {
    w: ARTIFACT_WIDTH, h: 180, card: String(row.id), kind: String(row.kind), projectId: String(project.id), project: cut(project.name, 120),
    title: cut(row.title, 160), command: artifactCommand(row),
    data: { type: 'artifact', kind: String(row.kind), state: cut(row.state, 240), at: typeof row.at === 'string' ? row.at : null, record: typeof row.record === 'string' ? row.record : null, fake: row.fake === true },
    readAt: now.toISOString(), open: false, gone: false,
  };
}

/**
 * Whether a change of a record is an artifact card fitting its own content (`a` before, `b` after): the card writes only its
 * height (Frame below), and it does so while a call of Timmy's may be running. Such a change is the page's, never the call's, so
 * it never refuses a draft (drafts.js followed() says the same of a drawn card's own following; canvas.js applies both).
 */
export function artifactFollowed(a, b) {
  if (!a || !b || a.typeName !== 'shape' || a.type !== ARTIFACT_SHAPE || b.type !== ARTIFACT_SHAPE) return false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (k !== 'props' && JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  const pa = a.props || {};
  const pb = b.props || {};
  for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (k !== 'h' && JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) return false;
  return true;
}

/**
 * What a card can show now. `scope`: the board on screen ({ project: { id, name } | null, state: 'shown' | 'switching' | 'paused'
 * | 'none', switching, paused }). It follows its artifact (`follows`) only while its own project's board is on screen.
 */
export function artifactMode(props, scope) {
  const name = props.project || 'its project';
  const s = scope || {};
  if (!PROJECT_ID.test(String(props.projectId ?? ''))) return { follows: false, words: 'This card names no project, so it shows nothing.' };
  if (s.state === 'switching') return { follows: false, words: `Studio is switching to ${s.switching ? s.switching.name : 'another project'}: this card shows nothing until a board is on screen.` };
  if (s.state === 'paused') return { follows: false, words: `Not shown now: ${one(s.paused) || 'the canvas shows a project this page cannot show.'}` };
  if (!s.project) return { follows: false, words: 'No board is on screen yet.' };
  if (s.project.id !== props.projectId) return { follows: false, words: `An artifact of ${name}: it is shown on ${name}'s own board only, and this board is ${s.project.name}'s.` };
  return { follows: true, words: '' };
}

/** A VoxVision preview's image to draw on its card: the observed input that has overlays, else the first image the route serves. */
export function cardImage(preview) {
  const images = Array.isArray(preview && preview.images) ? preview.images.filter((i) => i && i.servable === true && typeof i.path === 'string') : [];
  const overlays = Array.isArray(preview && preview.overlays) ? preview.overlays : [];
  return images.find((i) => i.role === 'input' && overlays.some((o) => o && o.image === i.key)) ?? images.find((i) => overlays.some((o) => o && o.image === i.key)) ?? images[0] ?? null;
}

/**
 * The overlays drawn on image `key`, as SVG shapes in the image's own frame: a box ({ shape: 'rect', x, y, w, h }), a polygon
 * ({ shape: 'polygon', points: 'x,y x,y …' }) or a point ({ shape: 'point', x, y }), each with its label, provenance and evidence.
 * The numbers are the record's own (H143's preview took them from the record); nothing is computed but their SVG form.
 */
export function overlayShapes(overlays, key) {
  const list = Array.isArray(overlays) ? overlays : [];
  const ok = (n) => typeof n === 'number' && Number.isFinite(n);
  const out = [];
  for (const o of list) {
    if (!o || o.image !== key || !Array.isArray(o.points) || !o.points.every(ok)) continue;
    const base = { id: String(o.id ?? ''), label: one(o.label), provenance: one(o.provenance), evidence: one(o.evidence), word: one(o.word) };
    if (o.shape === 'box' && o.points.length === 4) {
      const [x0, y0, x1, y1] = o.points;
      out.push({ ...base, shape: 'rect', x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) });
    } else if (o.shape === 'polygon' && o.points.length >= 6 && o.points.length % 2 === 0) {
      const pairs = [];
      for (let i = 0; i < o.points.length; i += 2) pairs.push(`${o.points[i]},${o.points[i + 1]}`);
      out.push({ ...base, shape: 'polygon', points: pairs.join(' ') });
    } else if (o.shape === 'point' && o.points.length >= 2) {
      out.push({ ...base, shape: 'point', x: o.points[0], y: o.points[1] });
    }
  }
  return out;
}

/** An overlay's line in a legend: its label, then provenance · evidence (the record's words). */
export const overlayLine = (s) => `${s.label || s.id}${s.provenance ? ` · ${s.provenance}` : ''}${s.evidence ? ` · ${s.evidence}` : ''}`;

/** A receipt's state as a card draws it: green only when `verified` (read now). */
export function receiptMark(receipt) {
  // R10 (H167; the round's rule: ids behind a details control): the mark in words; the receipt's id (`id`) is its Details' or tip's
  if (!receipt || typeof receipt !== 'object') return { tone: 'none', text: 'no receipt read', id: '' };
  const id = typeof receipt.short === 'string' ? receipt.short : '';
  if (receipt.verified === true) return { tone: 'verified', text: '✓ sealed and verified', id };
  if (/does not verify/.test(String(receipt.words ?? ''))) return { tone: 'failed', text: `✕ ${faceWords(one(receipt.words))}`, id };
  return { tone: 'none', text: faceWords(one(receipt.words)) || 'not sealed', id };
}

/** A run detail's files the card lists as the run's outputs (what it made or changed), and its other files. */
export function runOutputs(detail) {
  const files = Array.isArray(detail && detail.files) ? detail.files : [];
  const made = new Set(['output', 'preview', 'native', 'log']);
  return { outputs: files.filter((f) => f && made.has(f.role)), others: files.filter((f) => f && !made.has(f.role)) };
}

/** The words the Artifacts list says while Studio switches boards (null when it does not). */
export const holdWords = (scope) => (scope && scope.state === 'switching' ? `switching to ${scope.switching ? scope.switching.name : 'another project'}…` : null);

/** What a placement refused while Studio switches (or shows no board) says. */
export function notNowWords(scope) {
  if (scope && scope.state === 'switching') return `Not placed: Studio is switching to ${scope.switching ? scope.switching.name : 'another project'}, so nothing is placed on either board until its board is loaded.`;
  if (scope && scope.state === 'paused') return `Not placed: ${one(scope.paused) || 'the canvas shows a project this page cannot show.'}`;
  return 'Not placed: no board is on screen yet.';
}

// ── the cards, the list and the preview (the browser only) ─────────────────────────────────────────────────────────────

/**
 * The artifact card's shape util, the Artifacts list in the side panel and Studio's VoxVision preview. `deps`: React,
 * BaseBoxShapeUtil, HTMLContainer, T, atom, useValue, resizeBox, createShapeId; editor() (the editor on screen); scope() (the board
 * on screen, as artifactMode reads it); ticket() and current(ticket) (./identity.js: whose board a request was made for, and whether
 * it still is); kept(project, detail) (a "Kept apart" line for a reading of `project` dropped after a switch); read(path, projectId)
 * and image(id, path, projectId) (./cards.js: with this page's session, never handed out); forget(url); readRun(op, projectId) and
 * runDetail(op, projectId) (an operation's run detail: read for a card, shown in the side panel); place(editor, size) and
 * reveal(editor, ids); say(text, bad) (the panel's band).
 */
export function createArtifacts(deps) {
  const { React, BaseBoxShapeUtil, HTMLContainer, T, atom, useValue, resizeBox } = deps;
  const h = React.createElement;
  /** The board on screen, for every card: bumped when it changes (scopeChanged), so each card draws again. */
  const scopeAtom = atom('timmy artifacts: the board on screen', { n: 0, scope: deps.scope() });
  /** The last list read for the board on screen (its project's), or null. */
  const listAtom = atom('timmy artifacts: the list', { answer: null, error: null, project: null });
  /** Each card's reading of its artifact, by `<project>|<artifact>`: { state: 'reading' | 'read' | 'refused', body, at, sig }. */
  const readings = atom('timmy artifacts: readings', {});
  const setReading = (key, v) => readings.update((all) => ({ ...all, [key]: { ...(all[key] || {}), ...v } }));
  const handled = (e) => { const ed = deps.editor(); if (ed) ed.markEventAsHandled(e); };
  /**
   * The card placed last, for a few seconds (shape id → until when): a card grows as its artifact is read (its image comes after
   * its first drawing), so while it is new it is brought into view again each time its height changes, its action with it (it
   * would otherwise sit under tldraw's toolbar). Only the newest: an earlier card never takes the camera from it.
   */
  const justPlaced = new Map();
  const KEEP_IN_VIEW_MS = 6000;
  const span = (cls, text, extra = {}) => h('span', { className: cls, ...extra }, text);
  const para = (cls, text) => (one(text) ? h('p', { className: cls }, text) : null);

  /** Reads one artifact for its card (a VoxVision record's preview, or a run's run detail), once per list reading that changed it. */
  async function readArtifact(key, projectId, projectName, row) {
    const ticket = deps.ticket();
    setReading(key, { state: 'reading' });
    let r;
    try {
      r = row.kind === 'vox' ? await deps.read(`/api/project/artifact/vox?id=${row.preview.id}`, projectId)
        : row.kind === 'run' ? await deps.readRun(row.preview.op, projectId)
          : { status: 200, ok: true, body: { ok: true } };
    } catch (e) { r = { status: 0, ok: false, body: { ok: false, error: e instanceof Error ? e.message : String(e) } }; }
    // read for a board Studio has left since: dropped, said in the "Kept apart" log, and nothing of it is drawn
    if (!deps.current(ticket)) { if (r && r.ok) deps.kept({ id: projectId, name: projectName }, `its ${KIND_WORDS[row.kind] || 'artifact'} ${row.id}`); setReading(key, { state: 'idle', sig: '' }); return; }
    const b = (r && r.body) || {};
    if (r && r.ok && b.ok === true) setReading(key, { state: 'read', body: b, at: new Date().toISOString(), error: null });
    else setReading(key, { state: 'refused', body: null, error: one(b.error) || `Timmy answered ${r ? r.status : 0}.`, at: new Date().toISOString() });
  }

  // ── a card ──
  function useArtifact(shape) {
    const sc = useValue('timmy artifacts: scope', () => scopeAtom.get(), []);
    const list = useValue('timmy artifacts: list', () => listAtom.get(), []);
    const p = shape.props;
    const mode = artifactMode(p, sc.scope);
    const row = mode.follows && list.answer && list.project === p.projectId ? (list.answer.artifacts || []).find((a) => a.id === p.card) ?? null : null;
    const key = `${p.projectId}|${p.card}`;
    const reading = useValue('timmy artifacts: this card\'s reading', () => readings.get()[key] ?? null, [key]);
    // read again when the list says something new of it (its state, its receipt), and only for its own project's board on screen
    const sig = row ? JSON.stringify([row.state, row.receipt, row.at, row.counts]) : '';
    React.useEffect(() => {
      if (!mode.follows || !row) return;
      const now = readings.get()[key];
      if (now && now.sig === sig && now.state !== 'idle') return;
      setReading(key, { sig });
      void readArtifact(key, p.projectId, p.project, row);
    }, [mode.follows, key, sig]);
    return { mode, row, reading, list };
  }

  /** The card's face: its kind, title and project; its body; its one action; when it was read. */
  function Frame({ shape, mode, row, children, action, readAt, gone }) {
    const ref = React.useRef(null);
    const p = shape.props;
    React.useLayoutEffect(() => {
      const el = ref.current;
      const editor = deps.editor();
      if (!el || !editor) return undefined;
      const fit = () => {
        const want = Math.max(80, Math.ceil(el.scrollHeight) + 2);
        const now = editor.getShape(shape.id);
        if (now && Math.abs(now.props.h - want) > 1) {
          editor.run(() => editor.updateShape({ id: shape.id, type: shape.type, props: { h: want } }), { history: 'ignore' });
          const until = justPlaced.get(shape.id);
          if (until && Date.now() < until) { try { deps.reveal(editor, [shape.id]); } catch { /* showing it is a courtesy */ } } else if (until) justPlaced.delete(shape.id);
        }
      };
      fit();
      if (typeof ResizeObserver === 'undefined') return undefined;
      const ro = new ResizeObserver(fit);
      ro.observe(el);
      return () => ro.disconnect();
    }, [shape.id, shape.type]);
    const kept = p.data && p.data.type === 'artifact' ? p.data : null;
    return h(HTMLContainer, { className: `ta ta-${p.kind}`, 'data-timmy-artifact': shape.id, 'data-artifact': p.card, 'data-project': p.projectId, style: { width: p.w, height: p.h, pointerEvents: 'all' } },
      h('div', { ref, className: 'ta-inner', role: 'group', 'aria-label': `${KIND_WORDS[p.kind] || 'artifact'} card: ${p.title}` },
        h('div', { className: 'ta-head' },
          // (R10 H167: in words; the record's whole title, with its ids and places, is the title's tip)
          h('strong', { className: 'ta-title', title: p.title || p.card }, faceTitle(p.title) || KIND_WORDS[p.kind] || 'artifact'),
          span('ta-badge', KIND_WORDS[p.kind] || 'artifact'),
          (row ? row.fake : kept && kept.fake) ? span('ta-fake', 'FAKE', { title: 'Made by a test double, or said FAKE by its record: not a real observation' }) : null),
        h('p', { className: 'ta-project', title: `${p.project || 'its project'} · ${p.card}` }, p.project || 'its project'),
        mode.follows ? null : h('p', { className: 'ta-mode' }, mode.words),
        mode.follows && gone ? h('p', { className: 'ta-mode ta-warn' }, `Its record is not in ${p.project} now: shown as last read.`) : null,
        mode.follows ? children : (kept ? para('ta-state ta-last', `As last read: ${kept.state}`) : null),
        h('div', { className: 'ta-foot' },
          mode.follows && action ? action : (p.command ? h('code', { className: 'tc-cmd', title: 'Type this in Timmy' }, p.command) : null),
          span('ta-read', mode.follows && readAt ? `read from Timmy's records at ${clockOf(readAt)}` : p.readAt ? `as last read at ${clockOf(p.readAt)}` : 'never read', { title: mode.follows ? readAt || '' : p.readAt }))));
  }

  /** The image a card or the preview draws: read with this page's session, shown from memory; the object URL let go after. */
  function Picture({ id, path, projectId, alt }) {
    const [src, setSrc] = React.useState(null);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
      let made = null;
      let gone = false;
      deps.image(id, path, projectId).then((url) => {
        if (gone) { deps.forget(url); return; }
        made = url;
        if (url) setSrc(url); else setFailed(true);
      }, () => { if (!gone) setFailed(true); });
      return () => { gone = true; deps.forget(made); };
    }, [id, path, projectId]);
    if (src) return h('img', { src, alt, draggable: false, 'data-ta-image': path });
    return span('ta-note', failed ? `${path}: not read now` : `${path}: reading…`);
  }

  /** The overlays of an image, as SVG over it, in the image's own frame (its `frame`: width and height). */
  function Overlays({ shapes, frame }) {
    if (!shapes.length || !Array.isArray(frame) || !(frame[0] > 0) || !(frame[1] > 0)) return null;
    const cls = (s) => `ta-ov${s.provenance === 'generated' ? ' is-generated' : ''}${s.evidence === 'unverified' ? ' is-unverified' : ''}`;
    const r = Math.max(frame[0], frame[1]) / 60;
    return h('svg', { className: 'ta-overlay', viewBox: `0 0 ${frame[0]} ${frame[1]}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      ...shapes.map((s, i) => (s.shape === 'rect' ? h('rect', { key: i, className: cls(s), x: s.x, y: s.y, width: s.w, height: s.h, 'data-ov': s.id })
        : s.shape === 'polygon' ? h('polygon', { key: i, className: cls(s), points: s.points, 'data-ov': s.id })
          : h('circle', { key: i, className: cls(s), cx: s.x, cy: s.y, r, 'data-ov': s.id }))));
  }

  /** One image of a VoxVision record with what was measured over it, and the legend of those overlays (each labelled). */
  function Observed({ preview, image, projectId, max = 4 }) {
    const shapes = overlayShapes(preview.overlays, image.key);
    const frame = Array.isArray(image.frame) ? image.frame : null;
    return h('figure', { className: 'ta-figure' },
      h('div', { className: 'ta-stage' }, h(Picture, { id: preview.id, path: image.path, projectId, alt: `${image.title || image.path}` }), h(Overlays, { shapes, frame })),
      h('figcaption', { className: 'ta-caption' }, `${image.title || image.path} · ${image.path}${image.matches === true ? ' · its bytes the recorded ones' : image.matches === false ? ' · changed since the record' : ''}`),
      shapes.length ? h('ul', { className: 'ta-legend' }, ...shapes.slice(0, max).map((s, i) => h('li', { key: i, 'data-ov': s.id }, span('ta-ov-mark', s.shape === 'rect' ? '▭' : s.shape === 'polygon' ? '⬠' : '•', { 'aria-hidden': 'true' }), ' ', overlayLine(s))),
        shapes.length > max ? h('li', { key: 'more', className: 'ta-note' }, `${shapes.length - max} more: Open preview lists them`) : null)
        : para('ta-note', frame ? 'Nothing was measured over this image.' : 'Its frame is not recorded, so nothing is drawn over it.'));
  }

  const receiptLine = (receipt) => {
    const m = receiptMark(receipt);
    return h('p', { className: `ta-receipt ta-r-${m.tone}`, title: m.id ? `receipt ${m.id}` : undefined }, m.text);
  };

  function VoxBody({ shape, row, reading }) {
    const p = shape.props;
    const preview = reading && reading.state === 'read' && reading.body ? reading.body.preview : null;
    const image = preview ? cardImage(preview) : null;
    return h(React.Fragment, null,
      para('ta-state', row ? row.state : ''),
      preview && preview.fake && preview.fake.is ? para('ta-fake-words', preview.fake.words) : null,
      reading && reading.state === 'refused' ? para('ta-note ta-warn', `Not read: ${reading.error}`) : null,
      !preview && (!reading || reading.state === 'reading') ? para('ta-note', 'Reading the record…') : null,
      preview && image ? h(Observed, { preview, image, projectId: p.projectId }) : preview ? para('ta-note', 'This record names no image the board can show.') : null,
      row ? receiptLine(row.receipt) : null);
  }

  function RunBody({ row, reading }) {
    const d = reading && reading.state === 'read' && reading.body ? reading.body.detail : null;
    const files = d ? runOutputs(d) : { outputs: [], others: [] };
    return h(React.Fragment, null,
      para('ta-state', row ? row.state : ''),
      reading && reading.state === 'refused' ? para('ta-note ta-warn', `Its run detail was not read: ${reading.error}`) : null,
      !d && (!reading || reading.state === 'reading') ? para('ta-note', 'Reading its run detail…') : null,
      d ? para('ta-verdict', `Timmy's verdict: ${one(d.verdict && d.verdict.state)}${d.verdict && d.verdict.words ? ` · ${one(d.verdict.words)}` : ''}`) : null,
      d ? h('div', { className: 'ta-section' }, h('p', { className: 'ta-k' }, `Outputs (${files.outputs.length})`),
        files.outputs.length ? h('ul', { className: 'ta-files' }, ...files.outputs.slice(0, 6).map((f, i) => h('li', { key: i, 'data-ta-file': f.path }, span('ta-path', f.path), span('ta-note', ` · ${f.role}${f.sha256 ? ` · sha256 ${String(f.sha256).slice(0, 12)}` : ''}`))))
          : para('ta-note', 'Its records name no output.')) : null,
      d ? h('div', { className: 'ta-section' }, h('p', { className: 'ta-k' }, `Receipts (${(d.receipts || []).length})`),
        (d.receipts || []).length ? h('ul', { className: 'ta-files' }, ...(d.receipts || []).slice(0, 6).map((x, i) => h('li', { key: i, 'data-ta-receipt': x.id }, span('ta-path', x.id), span('ta-note', ` · ${x.kind}${x.subject ? ` · ${cut(x.subject, 80)}` : ''}`))))
          : para('ta-note', 'Its records name no receipt.')) : null);
  }

  function ReceiptBody({ row }) {
    return h(React.Fragment, null, para('ta-state', row ? `status ${row.state}` : ''), row ? receiptLine(row.receipt) : null, row && row.at && dateTimeOf(row.at) ? para('ta-note', `sealed ${dateTimeOf(row.at)}`) : null);
  }

  /** The card's one action: Open preview (Studio's VoxVision preview, the run detail, or the receipt page). */
  function actionOf(shape, row) {
    if (!row) return null;
    const p = shape.props;
    const open = () => {
      if (row.kind === 'vox') void openVox(row.preview.id, p.projectId);
      else if (row.kind === 'run') void deps.runDetail(row.preview.op, p.projectId);
      else if (row.kind === 'receipt' && row.preview && typeof row.preview.href === 'string' && /^\/receipts\/[0-9a-f]{8}$/.test(row.preview.href)) window.open(row.preview.href, '_blank', 'noopener,noreferrer');
    };
    return h('button', { type: 'button', className: 'tc-btn ta-open', 'data-ta-act': 'preview', onPointerDown: handled, onClick: open, title: row.kind === 'vox' ? 'Shows this record in Timmy\'s side panel: every image with what was measured over it, its values and its receipt' : row.kind === 'run' ? `Shows the run detail of operation ${row.preview.op} in Timmy's side panel` : `Opens receipt ${row.receipt ? row.receipt.short : ''}'s page (Studio's receipt page) in a new tab` }, OPENS[row.kind] || 'Open preview');
  }

  function ArtifactCard({ shape }) {
    const { mode, row, reading, list } = useArtifact(shape);
    const p = shape.props;
    const gone = mode.follows && !!list.answer && list.project === p.projectId && !row;
    const body = !row ? null : p.kind === 'vox' ? h(VoxBody, { shape, row, reading }) : p.kind === 'run' ? h(RunBody, { row, reading }) : h(ReceiptBody, { row });
    const readAt = reading && reading.at ? reading.at : list.answer ? list.answer.madeAt : '';
    return h(Frame, { shape, mode, row, action: actionOf(shape, row), readAt, gone }, body);
  }

  const props = {
    w: T.number, h: T.number, card: T.string, kind: T.string, projectId: T.string, project: T.string, title: T.string, command: T.string,
    data: T.jsonValue, readAt: T.string, open: T.boolean, gone: T.boolean,
  };
  class ArtifactUtil extends BaseBoxShapeUtil {
    static type = ARTIFACT_SHAPE;
    static props = props;
    getDefaultProps() { return { w: ARTIFACT_WIDTH, h: 180, card: '', kind: '', projectId: '', project: '', title: '', command: '', data: null, readAt: '', open: false, gone: false }; }
    hideRotateHandle() { return true; }
    canEdit() { return false; }
    onResize(shape, info) { const next = resizeBox(shape, info); return { ...next, y: shape.y, props: { ...next.props, h: shape.props.h } }; }
    getText(shape) { return `${shape.props.title}\n${shape.props.command}`; }
    component(shape) { return h(ArtifactCard, { shape }); }
    getIndicatorPath(shape) { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path; }
  }

  // ── the side panel's Artifacts list ──
  const el = (tag, text, o = {}) => Object.assign(document.createElement(tag), text === undefined ? {} : { textContent: text }, o);
  const box = () => document.getElementById('artifacts');
  let shownSig = '';

  /** The list read for the board on screen; one that comes back after a switch is dropped (and said so). Null when not read. */
  async function readList() {
    const sc = deps.scope();
    if (sc.state !== 'shown' || !sc.project) return null;
    const ticket = deps.ticket();
    let r;
    try { r = await deps.read('/api/project/artifacts', ticket.project); } catch (e) { r = { status: 0, ok: false, body: { ok: false, error: e instanceof Error ? e.message : String(e) } }; }
    if (!deps.current(ticket)) {
      if (r && r.ok && r.body && r.body.ok === true && r.body.project) deps.kept(r.body.project, 'its artifacts');
      return { dropped: true };
    }
    return { r, ticket };
  }

  function holdList(words) {
    const b = box();
    if (!b) return;
    document.getElementById('artifacts-name').textContent = words;
    document.getElementById('artifact-list').replaceChildren();
    const note = document.getElementById('artifacts-note');
    note.hidden = true;
    shownSig = '';
  }

  function drawList(answer, error) {
    const b = box();
    if (!b) return;
    const name = document.getElementById('artifacts-name');
    const note = document.getElementById('artifacts-note');
    const list = document.getElementById('artifact-list');
    const sig = JSON.stringify([answer && answer.project, answer && answer.artifacts, answer && answer.notes, error]);
    if (sig === shownSig) return;
    shownSig = sig;
    if (!answer) {
      name.textContent = 'not read';
      note.hidden = false;
      note.textContent = error || 'The project\'s artifacts could not be read.';
      list.replaceChildren();
      return;
    }
    const rows = answer.artifacts || [];
    name.textContent = `${answer.project.name} · ${rows.length}`;
    note.hidden = !(answer.notes || []).length;
    note.textContent = (answer.notes || []).join(' ');
    list.replaceChildren(...(rows.length ? rows.map((row) => {
      const li = el('li', undefined, { className: 'aitem' });
      li.dataset.artifact = row.id;
      li.dataset.project = answer.project.id;
      const head = el('div', undefined, { className: 'aitem-head' });
      // R10 (H167): the item in words (no operation id, receipt id or folder); its record's own words, whole, under its Details
      head.append(el('span', KIND_WORDS[row.kind] || row.kind, { className: 'aitem-kind' }), ' ', el('span', faceTitle(row.title) || KIND_WORDS[row.kind] || row.kind, { className: 'aitem-title' }));
      if (row.fake) head.append(' ', el('span', 'FAKE', { className: 'aitem-fake' }));
      li.append(head, el('div', faceWords(row.state), { className: 'aitem-state' }));
      const m = row.receipt ? receiptMark(row.receipt) : null;
      if (m && (row.kind !== 'run')) li.append(el('div', m.text, { className: `aitem-receipt ta-r-${m.tone}` }));
      const said = [faceTitle(row.title) !== String(row.title ?? '') ? row.title : '', faceWords(row.state) !== String(row.state ?? '') ? row.state : '', m && m.id ? `receipt ${m.id}` : ''].filter(Boolean);
      const acts = el('div', undefined, { className: 'aitem-acts' });
      const put = el('button', 'Place on the board', { type: 'button', className: 'aitem-place', title: 'Places this artifact on this project\'s board as a card that shows it and opens its preview' });
      put.addEventListener('click', () => {
        put.disabled = true;
        place(row.id).then((r) => deps.say(`Placed on ${r.project}'s board: ${cut(r.title, 90)}`), (e) => deps.say(e instanceof Error ? e.message : String(e), true)).finally(() => { put.disabled = false; });
      });
      acts.append(put);
      if (said.length) {
        const more = el('details', undefined, { className: 'aitem-more' });
        more.append(el('summary', 'Details'), ' ', ...said.map((w) => el('div', w, { className: 'aitem-said' })));
        acts.append(more);
      }
      li.append(acts);
      return li;
    }) : [el('li', `No artifacts yet in ${answer.project.name}: VoxVision records, runs and receipts show here.`, { className: 'aitem-empty' })]));
  }

  /** Reads the list now (when a board is on screen) and draws it, handing it to the cards. */
  async function poll() {
    const sc = deps.scope();
    const held = holdWords(sc);
    if (held) { holdList(held); listAtom.set({ answer: null, error: null, project: null }); return; }
    if (sc.state !== 'shown') { holdList(sc.state === 'paused' ? 'not shown now' : 'reading…'); return; }
    const got = await readList();
    if (!got || got.dropped) return;
    const { r } = got;
    const b = (r && r.body) || {};
    if (r && r.ok && b.ok === true && b.project && b.project.id === got.ticket.project) {
      listAtom.set({ answer: b, error: null, project: b.project.id });
      drawList(b, null);
    } else {
      listAtom.set({ answer: null, error: one(b.error) || `Timmy answered ${r ? r.status : 0}.`, project: null });
      drawList(null, one(b.error) || `Timmy answered ${r ? r.status : 0} for the artifacts.`);
    }
  }

  /**
   * Places artifact `id` of the board on screen's project as its card. Refused while Studio switches (or shows no board); a list
   * read for the placement that comes back after a switch places nothing on either board (and the "Kept apart" log says so).
   */
  async function place(id) {
    const sc = deps.scope();
    if (sc.state !== 'shown' || !sc.project) throw new Error(notNowWords(sc));
    if (!ARTIFACT_ID.test(String(id))) throw new Error(`Not placed: ${cut(id, 60)} is not an artifact's id (vox:v…, run:o… or receipt:…).`);
    const got = await readList();
    if (!got) throw new Error(notNowWords(deps.scope()));
    if (got.dropped) throw new Error(`Not placed: Studio switched boards while it read ${sc.project.name}'s artifacts, so nothing was placed on either board.`);
    const b = (got.r && got.r.body) || {};
    if (!(got.r && got.r.ok && b.ok === true && b.project && b.project.id === got.ticket.project)) throw new Error(`Not placed: ${one(b.error) || `Timmy answered ${got.r ? got.r.status : 0}.`}`);
    listAtom.set({ answer: b, error: null, project: b.project.id });
    drawList(b, null);
    const row = (b.artifacts || []).find((a) => a.id === id);
    if (!row) throw new Error(`Not placed: no artifact ${id} in ${b.project.name} now.`);
    const editor = deps.editor();
    if (!editor || !deps.current(got.ticket)) throw new Error(`Not placed: Studio switched boards, so nothing was placed on either board.`);
    // R7 (H151; H147's R6 finding 5, review/H147/caps/studio/24-image-added.png: "placed cards cover existing shapes"): where it
    // overlaps no shape on the page (canvas.js placeAt, ./placement.js), cards placed one after another included; it had gone right
    // of the rightmost card, over whatever was there. Its height fits its content once drawn: then it is moved clear if it grew
    // over a shape.
    const at = deps.place(editor, { w: ARTIFACT_WIDTH, h: ARTIFACT_PLACE_H });
    const shapeId = deps.createShapeId();
    // (R10 H167; H172's RESULTS of 00:02, from CI's studio-artifacts-browser at 704d8510: the newest placement keeps the camera.
    // An earlier card still in its few seconds that grew after a newer one was placed took the camera back to itself, and the
    // card just placed went off screen; now only the newest is brought into view again as it grows)
    justPlaced.clear();
    justPlaced.set(shapeId, Date.now() + KEEP_IN_VIEW_MS);
    editor.createShape({ id: shapeId, type: ARTIFACT_SHAPE, x: at.x, y: at.y, props: artifactProps(row, b.project) });
    editor.select(shapeId);
    try { deps.reveal(editor, [shapeId]); } catch { /* showing it is a courtesy */ }
    if (deps.keepClear) await deps.keepClear(editor, [shapeId]);
    return { placed: true, shape: shapeId, artifact: row.id, kind: row.kind, title: row.title, project: b.project.name };
  }

  // ── Studio's VoxVision preview, in the side panel ──
  let previewOf = null;
  let previewAsked = 0;
  /** The preview's images (drawn by the cards' own React parts into #artifact-preview-images), or none (null). */
  const drawImages = (element) => { const host = document.getElementById('artifact-preview-images'); if (host && deps.render) deps.render(host, element); };
  /** Closes the preview (also when its project's board leaves the screen): nothing of it stays on the page. */
  function closePreview() {
    const root = document.getElementById('artifact-preview');
    if (root) { root.hidden = true; delete root.dataset.project; delete root.dataset.vox; }
    drawImages(null);
    const body = document.getElementById('artifact-preview-body');
    if (body) body.replaceChildren();
    const fake = document.getElementById('artifact-preview-fake');
    if (fake) { fake.hidden = true; fake.textContent = ''; }
    previewOf = null;
    previewAsked += 1;
  }
  /**
   * Shows VoxVision record `id` of project `projectId` in the side panel: every image the record names with what was measured over
   * it, each overlay with its label, provenance and evidence, the values, the check and the receipt (green only when it verifies
   * now), FAKE said; and where the companion shows it in full. Only for the board on screen's project.
   */
  async function openVox(id, projectId) {
    const root = document.getElementById('artifact-preview');
    const body = document.getElementById('artifact-preview-body');
    const title = document.getElementById('artifact-preview-title');
    const readAt = document.getElementById('artifact-preview-read');
    if (!root || !body) return;
    const sc = deps.scope();
    if (artifactMode({ projectId, project: sc.project ? sc.project.name : '' }, sc).follows !== true) { deps.say(notNowWords(sc).replace('Not placed', 'Not shown'), true); return; }
    const n = ++previewAsked;
    previewOf = { id, projectId };
    root.hidden = false;
    root.dataset.project = projectId;
    root.dataset.vox = id;
    title.textContent = `VoxVision record ${id}`;
    readAt.textContent = '';
    drawImages(null);
    const fakeLine = document.getElementById('artifact-preview-fake');
    if (fakeLine) { fakeLine.hidden = true; fakeLine.textContent = ''; }
    body.replaceChildren(el('p', 'Reading it from Timmy…', { className: 'rd-note' }));
    try { root.scrollIntoView({ block: 'nearest' }); } catch { /* shown either way */ }
    const ticket = deps.ticket();
    let r;
    try { r = await deps.read(`/api/project/artifact/vox?id=${id}`, projectId); } catch (e) { r = { status: 0, ok: false, body: { ok: false, error: e instanceof Error ? e.message : String(e) } }; }
    if (n !== previewAsked) return;
    if (!deps.current(ticket)) { closePreview(); deps.kept({ id: projectId, name: sc.project ? sc.project.name : projectId }, `VoxVision record ${id}, for its preview`); return; }
    const b = (r && r.body) || {};
    readAt.textContent = `Read from Timmy's records at ${clockOf(new Date())}. It does not change by itself: Open preview reads it again.`;
    if (!(r && r.ok && b.ok === true && b.preview)) { body.replaceChildren(el('p', `Not read: ${one(b.error) || `Timmy answered ${r ? r.status : 0}.`}`, { className: 'rd-note rd-refused' })); return; }
    const v = b.preview;
    title.textContent = `VoxVision record ${v.id} · ${v.action} · ${v.status}`;
    const parts = [];
    // FAKE (a test double made it, or the record says so) is said first, above the images
    const fake = document.getElementById('artifact-preview-fake');
    if (fake) { fake.hidden = !(v.fake && v.fake.is); fake.textContent = v.fake && v.fake.is ? v.fake.words || 'FAKE' : ''; }
    // each image the route serves, with its overlays, drawn by the same React parts as the cards (above the words)
    const images = (v.images || []).filter((i) => i && i.servable === true);
    if (images.length) drawImages(h(React.Fragment, null, ...images.map((im, k) => h(Observed, { key: `${v.id}:${k}`, preview: v, image: im, projectId, max: 40 }))));
    else parts.push(el('p', 'This record names no image Studio can show.', { className: 'rd-note' }));
    const notShown = (v.images || []).filter((i) => i && i.servable !== true);
    for (const im of notShown) parts.push(el('p', `${im.path}: not shown (${one(im.why) || 'the route does not serve it'})`, { className: 'rd-note' }));
    if ((v.values || []).length) {
      const dl = el('dl', undefined, { className: 'rd-dl ap-values' });
      for (const x of v.values.slice(0, 24)) dl.append(el('dt', x.title || x.name), el('dd', `${x.text} · ${x.provenance} · ${x.evidence}${x.word ? ` · ${x.word}` : ''}`));
      parts.push(el('h3', 'Values'), dl);
    }
    const m = receiptMark(v.receipt);
    parts.push(el('p', `check: ${v.check ? v.check.status : 'unknown'}${v.check && v.check.reasons && v.check.reasons.length ? ` (${v.check.reasons.join('; ')})` : ''}`, { className: 'rd-note' }));
    parts.push(el('p', m.text, { className: `ap-receipt ta-r-${m.tone}` }));
    parts.push(el('p', COMPANION_VOX(v.id), { className: 'rd-note ap-companion' }));
    parts.push(el('p', undefined, { className: 'rd-note' }));
    parts[parts.length - 1].append('In Timmy: ', el('code', `/open ${v.file}`, { className: 'rd-cmd', title: 'Type this in Timmy' }));
    body.replaceChildren(...parts);
  }

  /** The board on screen changed (a switch began or ended, a pause): the cards draw again, the list follows, the preview closes. */
  function scopeChanged() {
    const scope = deps.scope();
    scopeAtom.set({ n: scopeAtom.get().n + 1, scope });
    if (previewOf && !(scope.state === 'shown' && scope.project && scope.project.id === previewOf.projectId)) closePreview();
    if (scope.state !== 'shown') listAtom.set({ answer: null, error: null, project: null });
    void poll();
  }

  function connect() {
    const close = document.getElementById('artifact-preview-close');
    if (close) close.addEventListener('click', closePreview);
    const next = () => setTimeout(() => { const go = document.visibilityState === 'visible' ? poll() : Promise.resolve(); go.finally(next); }, 5000);
    void poll().finally(next);
  }

  return { util: ArtifactUtil, place, poll, scopeChanged, openVox, closePreview, connect, list: () => listAtom.get() };
}
