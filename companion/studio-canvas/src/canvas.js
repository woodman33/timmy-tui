// Timmy Canvas (plan F-4): tldraw, pinned and bundled on this machine (fourth order, step 5),
// licensed from TLDRAW_LICENSE_KEY through the local server. scripts/canvas/build.mjs bundles this
// file with tldraw, React and tldraw's own fonts, icons, translations and embed icons into ../dist,
// so the canvas loads nothing from another host. The license key is never built in: the server
// hands it to the page at run time. The canvas itself is saved by Timmy, in its home, and opened
// from there: it reopens where it was, and the terminal reads the same document.
//
// R5 (H133): tldraw's chrome on Timmy's palette (./theme.js and index.html; DESIGN.md §10 B10), dark only; what Timmy proposes
// arrives as a draft the person accepts or discards (./drafts.js); the save says saving, saved, failed or conflict in words and
// a glyph, with a recovery path (./save-state.js); and the guided blank templates open as text and empty frames.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AccessibilityMenu, BaseBoxShapeUtil, Box, DEFAULT_THEME, DefaultMainMenu, EditSubmenu, ExportFileContentSubMenu, ExtrasGroup, HTMLContainer, InputModeMenu, KeyboardShortcutsMenuItem, LanguageMenu, T, Tldraw, TldrawUiMenuGroup, TldrawUiMenuSubmenu, ToggleDebugModeItem, ToggleDynamicSizeModeItem, ToggleEdgeScrollingItem, ToggleFocusModeItem, ToggleGridItem, TogglePasteAtCursorItem, ToggleSnapModeItem, ToggleToolLockItem, ToggleWrapModeItem, Vec, ViewSubmenu, atom, createBindingId, createShapeId, getSnapshot, resizeBox, toRichText, useEditor, useValue } from 'tldraw';
import { getAssetUrls } from '@tldraw/assets/selfHosted';
import 'tldraw/tldraw.css';
import { band, createProjectPanel } from './project.js';
import { createCards, drawnType } from './cards.js';
// R4 (H109): an operation's run detail (src/contracts/run-detail.ts, made by Timmy) in the side panel
import { createRunDetailPanel } from './run-detail.js';
// R5 (H133): B10 for tldraw's canvas colors; drafts; the save's words
import { timmyThemes } from './theme.js';
import { DRAFT_ID, DRAFT_LABEL, acceptPlan, decisionWords, documentChanges, draftLine, draftMark, draftOf, draftRefusal, discardPlan, pendingDrafts, remarkPlan, staleWords } from './drafts.js';
import { saveState } from './save-state.js';
// R5 (H133): the shared workspace frame (src/contracts/workspace.ts), as a strip above the canvas
import { createFrameStrip } from './frame.js';

// Round R4 (H75): the one-time grant /canvas open puts in this page's address (#code=…). It is taken out of the address at
// once (a fragment is never sent to a server) and traded for a session before anything else runs (./cards.js).
const GRANT_AT_LOAD = (() => {
  const m = /^#code=([0-9a-f]{32})$/.exec(location.hash);
  if (m) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* the grant is good once */ } }
  return m ? m[1] : null;
})();

/* global __TLDRAW_VERSION__ */
/** The tldraw version this bundle was built from (scripts/canvas/build.mjs). */
const BUILT_WITH = __TLDRAW_VERSION__;
const status = document.getElementById('status');
const say = (text, kind) => {
  status.textContent = text;
  status.dataset.kind = kind;
};

// tldraw's own verdict on the license, never inferred from a key being present.
const LICENSE = {
  pending: 'checking the license',
  licensed: 'licensed',
  'licensed-with-watermark': 'licensed (watermark)',
  unlicensed: 'unlicensed, fine locally',
  'unlicensed-production': 'no valid license for this address',
  expired: 'license expired',
};

/**
 * The canvas document as Timmy holds it. `revision` counts document changes (shapes, bindings,
 * pages, assets, by Timmy or by hand) and continues from the saved one; `savedRevision` is what the
 * file in Timmy's home holds, `sourceRevision` the sha256 of it. `conflict` is set when another
 * window saved first: this one then stops saving rather than overwrite it. R4 (H83): `refused` is set when Timmy refused a
 * save to this page's session (it no longer counts: another project or REPL holds the canvas, or it ended); the page's changes
 * stay in it, unsaved, and the next change tries again.
 * R5 (H133): `saving` while a save is on its way; `savedAt` when the last one landed; `failed` why the last save did not happen
 * (Timmy unreachable, too large, an error: the next change or Retry tries again); `conflict` is { words, revision } (the
 * revision on disk); `stale` ({ revision }) when the canvas on disk is newer than this page's last save, seen before a save;
 * `kept` where this page's version was kept as a copy. Neither conflict nor stale is ever saved over.
 */
const canvas = { revision: 0, savedRevision: 0, sourceRevision: null, savedAt: null, saving: false, failed: null, conflict: null, stale: null, kept: null, refused: null, notice: null, linked: false, timer: null };

/**
 * The live editor. A canvas call that crashes tldraw gets a fresh editor (round R1: see `restore`), so
 * everything that reaches the editor later (saves, the panel, the next call) goes through `current`,
 * never an editor kept from the first mount.
 */
let current = null;

/**
 * R4 (H109): the side panel's Run detail (index.html #run-detail), made when first asked: an operation's run detail read with
 * this page's session (./cards.js runDetail), from a card's Run detail or an operation's group in the Project panel.
 */
let runPanel = null;
function showRunDetail(op, projectId = null) {
  if (!runPanel) runPanel = createRunDetailPanel({ read: (o, p) => cards.runDetail(o, p) });
  return runPanel.show(op, projectId);
}

// Round R4 (H75): Timmy Canvas's own drawn cards (workflow, parameter and result), and the session their actions go with.
const cards = createCards({
  React, BaseBoxShapeUtil, HTMLContainer, T, atom, useValue, resizeBox, createShapeId, grant: GRANT_AT_LOAD,
  editor: () => current, place: (editor, size) => placeAt(editor, size), reveal: (editor, ids) => reveal(editor, ids),
  // R4 (H109): what Timmy did on its own (the arrows it removed with a deleted card), in the panel's band
  say: (text) => band(text),
  // R4 (H109): a card's Run detail
  runDetail: (op, projectId) => showRunDetail(op, projectId),
});

/** R5 (H133): the save in words for the status line's end (the save line, #save, says it in full). */
function savedWords(st) {
  if (st.state === 'saved') return `revision ${canvas.revision}, saved`;
  if (st.state === 'saving' || st.state === 'unsaved') return `revision ${canvas.revision}, saving`;
  return `revision ${canvas.revision}, not saved`;
}

function showStatus(editor) {
  const state = editor.licenseManager?.state.get() ?? 'unknown';
  window.timmyCanvas.licenseState = state;
  showSave();
  // R4 (H83): Timmy refused this page's save, in its own words (which say what to do).
  if (canvas.refused) {
    say(`Not saved: ${canvas.refused}`, 'refused');
    return;
  }
  const text = `Canvas ready · tldraw ${BUILT_WITH} · ${LICENSE[state] ?? `license state: ${state}`} · ${canvas.linked ? 'Timmy connected' : 'Timmy not connected'} · ${savedWords(saveState(canvas))}`;
  // R5 (H133): a newer canvas on disk is said in full by the save line and its box below; this line keeps its end short
  say(canvas.notice ? `${canvas.notice} ${text}` : text, canvas.conflict || canvas.stale ? 'error' : canvas.linked ? 'ready' : 'waiting');
  if (state === 'pending') setTimeout(() => current && showStatus(current), 250);
}

/**
 * R5 (H133): the save line (#save) and, when a newer version is on disk, the recovery box (#conflict): Reload takes the newer
 * version (this page's version kept as a copy first when it has unsaved changes), Keep a copy keeps it beside the canvas file.
 */
function showSave() {
  const st = saveState(canvas);
  const line = document.getElementById('save');
  if (!line) return;
  line.dataset.state = st.state;
  line.dataset.needsYou = String(st.needsYou);
  document.getElementById('save-glyph').textContent = st.glyph;
  document.getElementById('save-words').textContent = st.words;
  document.getElementById('save-retry').hidden = st.state !== 'failed';
  const box = document.getElementById('conflict');
  const newer = st.state === 'conflict' || st.state === 'stale';
  box.hidden = !newer;
  if (newer) document.getElementById('conflict-keep').disabled = Boolean(canvas.kept) && canvas.revision === canvas.keptRevision;
}

/** R5 (H133): the document as this page holds it, as the save sends it. */
const documentBody = () => JSON.stringify({ snapshot: getSnapshot(current.store).document, revision: canvas.revision, baseRevision: canvas.savedRevision });

// Saves go one at a time, each from the revision the last one left on disk.
let queue = Promise.resolve();
/** R5 (H133): the recording of decisions on drafts, one at a time (flushDecisions). */
let flushing = Promise.resolve();
async function saveNow() {
  const editor = current;
  if (canvas.conflict) return { ok: false, error: canvas.conflict.words };
  // R5 (H133): a newer canvas is on disk: this page never saves over it (Reload, or Keep a copy)
  if (canvas.stale) return { ok: false, error: saveState(canvas).words };
  if (canvas.revision === canvas.savedRevision) return { ok: true, revision: canvas.revision, sourceRevision: canvas.sourceRevision };
  const revision = canvas.revision;
  let status = 0;
  let reached = true;
  let saved;
  canvas.saving = true;
  showSave();
  try {
    // R4 (H83): saved with this page's session (./cards.js holds it; this file never sees it)
    const response = await cards.saveDocument(JSON.stringify({ snapshot: getSnapshot(editor.store).document, revision, baseRevision: canvas.savedRevision }));
    status = response.status;
    saved = response.body || { ok: false, error: `Timmy answered ${status} for the save.` };
  } catch (error) {
    reached = false;
    saved = { ok: false, error: `Timmy could not be reached to save the canvas (${error instanceof Error ? error.message : String(error)}).` };
  }
  canvas.saving = false;
  if (saved.ok) {
    canvas.savedRevision = saved.revision;
    canvas.sourceRevision = saved.sourceRevision;
    canvas.savedAt = typeof saved.savedAt === 'string' ? saved.savedAt : new Date().toISOString();
    canvas.notice = null;
    canvas.refused = null;
    canvas.failed = null;
    // R5 (H133): the decisions on drafts this save holds are recorded now, one at a time
    flushing = flushing.then(() => flushDecisions(saved)).catch(() => undefined);
  } else if (status === 409) {
    canvas.conflict = { words: saved.error, revision: Number.isInteger(saved.revision) ? saved.revision : null };
  } else if (reached && (status === 401 || status === 0)) {
    canvas.refused = saved.error || 'Timmy refused this page\'s save. In Timmy: /canvas open.';
  } else {
    // R5 (H133): not saved, and said so (it had stayed "saving" for good): Retry, or the next change, tries again
    canvas.failed = saved.error || `Timmy answered ${status} for the save.`;
  }
  showStatus(editor);
  return saved;
}
function save() {
  clearTimeout(canvas.timer);
  const run = queue.then(() => saveNow());
  queue = run.catch(() => undefined);
  return run;
}
const saveSoon = () => {
  clearTimeout(canvas.timer);
  canvas.timer = setTimeout(() => save(), 400);
};
/**
 * Leaving the page (closing the tab, reloading, going elsewhere) saves what the 400 ms wait has not.
 * A closing page can still send one small request (keepalive, up to 64 KB); a larger canvas sends
 * an ordinary one, which the browser may cut off: then the last 400 ms of changes can be lost.
 */
function saveOnLeave() {
  if (!current || canvas.conflict || canvas.stale || canvas.revision === canvas.savedRevision || !cards.hasSession()) return;
  clearTimeout(canvas.timer);
  const body = documentBody();
  cards.saveDocument(body, body.length < 60_000).catch(() => undefined);
}

/**
 * R5 (H133): the canvas on disk, as Timmy's health says (no content: its revision and source revision). A canvas newer than this
 * page's last save (another window saved it) marks this page stale before it tries to save over it. A reading that began before
 * this page's own last save landed, or while a save is on its way, is ignored.
 */
async function checkDisk() {
  if (!current || canvas.conflict || canvas.stale || canvas.saving) return;
  const asked = { revision: canvas.savedRevision, source: canvas.sourceRevision };
  let health;
  try {
    const r = await fetch('/api/canvas/health', { cache: 'no-store' });
    if (!r.ok) return;
    health = await r.json();
  } catch {
    return;
  }
  if (canvas.saving || canvas.savedRevision !== asked.revision || canvas.sourceRevision !== asked.source) return;
  if (!Number.isInteger(health.revision)) return;
  const newer = health.revision !== canvas.savedRevision || (health.revision > 0 && typeof health.sourceRevision === 'string' && canvas.sourceRevision && health.sourceRevision !== canvas.sourceRevision);
  if (newer) {
    canvas.stale = { revision: health.revision };
    clearTimeout(canvas.timer);
    showStatus(current);
  }
}

/** R5 (H133): Keep a copy: this page's version, kept beside the canvas file (it never replaces it). */
async function keepCopy() {
  if (!current) return null;
  const r = await cards.keepCopy(documentBody()).catch((error) => ({ status: 0, ok: false, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }));
  const said = r.body || {};
  if (r.ok && said.ok === true && typeof said.kept === 'string') {
    canvas.kept = said.kept;
    canvas.keptRevision = canvas.revision;
    band(`Kept this page's version (revision ${canvas.revision}) as ${said.kept}, beside the canvas file in Timmy's canvas folder. The canvas on disk is unchanged.`);
    showStatus(current);
    return said.kept;
  }
  band(`Not kept: ${said.error || `Timmy answered ${r.status}.`}`, true);
  return null;
}

/**
 * R5 (H133): Reload: the newer canvas from disk, in a fresh editor. This page's unsaved changes are kept as a copy first (never
 * lost without a copy); then the page shows and saves from the revision on disk.
 */
async function reloadFromDisk() {
  if (!current) return;
  if (canvas.revision !== canvas.savedRevision && !(canvas.kept && canvas.keptRevision === canvas.revision)) {
    if (!(await keepCopy())) return;
  }
  const opened = await cards.loadDocument();
  if (!opened.ok || !opened.body) {
    band(`Not reloaded: ${opened.why || `Timmy answered ${opened.status} for the saved canvas.`}`, true);
    return;
  }
  const disk = opened.body;
  clearTimeout(canvas.timer);
  await mount(disk.snapshot ? { document: disk.snapshot } : undefined);
  fitOnOpen(current);
  Object.assign(canvas, { revision: disk.revision, savedRevision: disk.revision, sourceRevision: disk.sourceRevision, savedAt: disk.savedAt ?? null, saving: false, failed: null, conflict: null, stale: null, refused: null });
  const kept = canvas.kept;
  canvas.kept = null;
  band(`Reloaded revision ${disk.revision} from disk.${kept ? ` This page's version is kept as ${kept}.` : ''}`);
  showStatus(current);
  showDrafts(current);
  showJobs(current);
}

// The agent bridge (F-4, slice 2): Timmy sends Editor API code; it runs here against the live editor
// and the answer goes back only after the canvas is saved, with the revision and the source revision
// of what was saved, so the terminal and the file agree on what the call produced. Calls run one at a
// time, and every shape created while a job's code runs carries that job's ID in meta.timmyJob.
// R5 (H133): a call sent as a draft marks what it creates (meta.timmyDraft) and only adds; one made from a revision the canvas
// has left is refused before it runs (./drafts.js).
const AsyncFunction = (async () => {}).constructor;
const MAX_ANSWER = 256 * 1024;
let runningJob = null;
/** R5 (H133): the mark of the draft the running call makes, or null when it is not a draft. */
let drafting = null;
let calls = Promise.resolve();
/** The shapes the running call has created, so they can be brought into view when it ends. */
let drawnInCall = null;

// What a call draws comes into view beside Timmy's panel, or below it when that leaves more room (a
// phone), above tldraw's toolbar (LIVE-01, ledger row 65: a rectangle drawn at (100, 100) sat hidden
// under the panel). A call that draws inside that area leaves the camera where it is.
// R4 (H88; the Mac run r23): the area beside the panel is taken whenever it is wide enough for a card (BESIDE_MIN), and below
// it only on a narrower screen: the panel's width is fixed but its height grows as its lists fill or a fold opens, and a card
// placed below a short panel sat partly under it once the panel grew (seen at 760 x 1600 and 700 x 1400).
const BESIDE_MIN = 240;
function freeArea() {
  const margin = 16;
  // R5 (H133): under tldraw's own top row, inside the canvas box, which starts under the workspace strip
  const top = (document.getElementById('root')?.getBoundingClientRect().top ?? 0) + 56;
  const side = document.getElementById('side')?.getBoundingClientRect();
  const bar = document.querySelector('.tlui-main-toolbar')?.getBoundingClientRect();
  const bottom = (bar && bar.height > 0 ? bar.top : innerHeight - 72) - margin;
  if (!side || side.width === 0) return { x: margin, y: top, w: innerWidth - 2 * margin, h: bottom - top };
  const right = { x: side.right + margin, y: top, w: innerWidth - side.right - 2 * margin, h: bottom - top };
  const below = { x: margin, y: side.bottom + margin, w: innerWidth - 2 * margin, h: bottom - side.bottom - margin };
  if (right.w >= BESIDE_MIN && right.h > 0) return right;
  return right.w * right.h >= below.w * below.h ? right : below;
}
/** `o.now`: the camera goes there at once (a board just opened), not with the 220 ms move a placed shape gets. */
function reveal(editor, ids, o = {}) {
  const page = editor.getCurrentPageId();
  const shown = ids.filter((id) => editor.getShape(id) && editor.getAncestorPageId(id) === page);
  const boxes = shown.map((id) => editor.getShapePageBounds(id)).filter(Boolean);
  if (boxes.length === 0) return;
  const bounds = Box.Common(boxes);
  const area = freeArea();
  if (area.w <= 0 || area.h <= 0) return;
  const from = editor.pageToScreen({ x: bounds.minX, y: bounds.minY });
  const to = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY });
  if (from.x >= area.x && from.y >= area.y && to.x <= area.x + area.w && to.y <= area.y + area.h) return;
  // Never closer than now; farther only as much as the drawing needs to fit, with a little room.
  const fit = Math.min(area.w / Math.max(1, bounds.w), area.h / Math.max(1, bounds.h)) * 0.9;
  const z = Math.max(0.05, Math.min(editor.getCamera().z, fit));
  const view = editor.getViewportScreenBounds();
  const center = bounds.center;
  editor.setCamera(
    { x: (area.x + area.w / 2 - view.x) / z - center.x, y: (area.y + area.h / 2 - view.y) / z - center.y, z },
    o.now ? undefined : { animation: { duration: 220 } },
  );
}

/** What every editor needs from Timmy: each shape a call creates carries the call's job, and every change counts and saves. */
function attachEditor(editor) {
  editor.sideEffects.registerBeforeCreateHandler('shape', (shape) => {
    drawnInCall?.add(shape.id);
    if (!runningJob && !drafting) return shape;
    // R5 (H133): a draft's shapes carry its mark as well as the job
    return { ...shape, meta: { ...shape.meta, ...(runningJob ? { timmyJob: runningJob } : {}), ...(drafting ? { timmyDraft: drafting } : {}) } };
  });
  // R5 (H133): an asset a draft brings (an image it shows) carries the mark too, so Discard takes it with the shapes
  editor.sideEffects.registerBeforeCreateHandler('asset', (asset) => (drafting ? { ...asset, meta: { ...asset.meta, timmyDraft: drafting } } : asset));
  const bump = () => {
    canvas.revision += 1;
    if (canvas.failed) canvas.failed = null;
    saveSoon();
    if (current) showStatus(current);
  };
  for (const type of ['shape', 'binding', 'page', 'asset']) {
    editor.sideEffects.registerAfterCreateHandler(type, bump);
    editor.sideEffects.registerAfterChangeHandler(type, bump);
    editor.sideEffects.registerAfterDeleteHandler(type, bump);
  }
  // R4 (H109; r25 D9): a drawn card a person deletes takes the arrows Timmy drew to or from it, in the same undo step
  cards.attach(editor);
}

const describe = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** Whether two documents hold the same records (the canvas before a call, and after its undo). */
function sameDocument(a, b) {
  const ka = Object.keys(a.store);
  if (ka.length !== Object.keys(b.store).length) return false;
  return ka.every((k) => k in b.store && JSON.stringify(a.store[k]) === JSON.stringify(b.store[k]));
}

/**
 * Round R1 (the Mac run): a call that fails keeps nothing. Its changes are undone to the mark set
 * before it ran; and when it crashed tldraw (a shape tldraw refuses throws inside the editor, and
 * tldraw then shows "Something went wrong" for good), the page starts a fresh editor from the canvas
 * as it was before the call, so the board stays usable and later calls draw where you can see them.
 */
async function restore(editor, before, mark, crashed) {
  if (crashed) {
    await mount(before);
    return;
  }
  editor.bailToMark(mark);
  // Changes made outside the undo history are not undone by the mark: load the earlier canvas instead.
  const now = getSnapshot(editor.store);
  if (!sameDocument(now.document, before.document)) editor.loadSnapshot(before);
}

/** R5 (H133): the draft a bridge message asks for ({ id, baseRevision }), or null when the call is not a draft. */
function draftAsked(message) {
  const d = message && message.draft;
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !DRAFT_ID.test(d.id)) return null;
  return { id: d.id, baseRevision: Number.isInteger(d.baseRevision) && d.baseRevision >= 0 ? d.baseRevision : null };
}

function connectBridge() {
  const helpers = { Box, Vec, createBindingId, createShapeId, toRichText };
  // R4 (H83): the page joins with its session (./cards.js makes the socket; this file never sees the session). A page Timmy
  // refuses (its session does not count now) asks again, less and less often; one whose session ended is told so (4401) and
  // asks no more.
  let wait = 2000;
  const open = () => {
    const ws = cards.bridgeSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bridge`);
    if (!ws) { canvas.linked = false; if (current) showStatus(current); return; }
    ws.onopen = () => { wait = 2000; canvas.linked = true; if (current) showStatus(current); };
    ws.onclose = (event) => {
      canvas.linked = false;
      if (event.code === 4401) cards.sessionEnded('This page\'s session with Timmy has ended, so Timmy sends it no more code. In Timmy: /canvas open gives a new page one.');
      if (current) showStatus(current);
      if (!cards.hasSession()) return;
      setTimeout(open, wait);
      wait = Math.min(wait * 2, 15_000);
    };
    const run = async (message) => {
      const editor = current;
      const before = getSnapshot(editor.store);
      const revisionBefore = canvas.revision;
      const draft = draftAsked(message);
      let answer;
      let drawn = [];
      if (draft && draft.baseRevision !== null && draft.baseRevision !== canvas.revision) {
        // R5 (H133): made from a revision the canvas has left: refused before its code runs, and said so
        answer = { ok: false, error: staleWords(draft.baseRevision, canvas.revision), stale: true, draft: { id: draft.id, refused: 'stale', from: draft.baseRevision, now: canvas.revision } };
      } else {
        const mark = editor.markHistoryStoppingPoint(`timmy ${typeof message.jobId === 'string' ? message.jobId : 'call'}`);
        runningJob = typeof message.jobId === 'string' ? message.jobId : null;
        const callMark = draft ? draftMark({ id: draft.id, job: runningJob, from: canvas.revision }) : null;
        drafting = callMark;
        drawnInCall = new Set();
        try {
          // R4 (H81): this code runs in this page's own realm, with the page's own rights: it can reach the network, replace
          // the page's globals and rewrite what the page and its cards show. It cannot read the cards' session or turn a
          // person's click on one card button into another's (./cards.js says how), but it can put a card's button under a
          // person's next click. The REPL's NEEDS YOU box for canvas_exec, asked before every script, is the barrier.
          const result = await new AsyncFunction('editor', 'helpers', message.code)(editor, helpers);
          const json = JSON.stringify(result === undefined ? null : result);
          answer = json.length > MAX_ANSWER
            ? { ok: false, error: `The result is too large to send back (${Math.round(json.length / 1024)} KB); return less.` }
            : { ok: true, result: JSON.parse(json) };
        } catch (error) {
          answer = { ok: false, error: describe(error) };
        } finally {
          runningJob = null;
          drafting = null;
        }
        drawn = [...drawnInCall];
        drawnInCall = null;
        const crash = typeof editor.getCrashingError === 'function' ? editor.getCrashingError() : null;
        // R5 (H133): a draft only adds; one that touched the board's own shapes keeps nothing, and says why. Everything the call
        // created carries this draft's mark when it ends, whatever its code did to the mark (code that stripped it would have
        // put its shapes on the board without the person's Accept).
        if (answer.ok && !crash && draft) {
          const after = getSnapshot(editor.store);
          const changes = documentChanges(before.document.store, after.document.store);
          const refusal = draftRefusal(changes, before.document.store, after.document.store);
          if (refusal) {
            answer = { ok: false, error: refusal, draft: { id: draft.id, refused: 'changes' } };
          } else {
            const unmarked = remarkPlan(changes.created.map((id) => editor.store.get(id)), callMark);
            if (unmarked.length) editor.run(() => editor.store.put(unmarked));
          }
        }
        if (!answer.ok || crash) {
          // Nothing a failed call drew is kept, and a crashed page is started again (see restore).
          if (answer.ok) answer = { ok: false, error: `The canvas page crashed during this call (${describe(crash)}).` };
          try {
            await restore(editor, before, mark, Boolean(crash));
            answer.rolledBack = true;
            if (crash) answer.restarted = true;
            // The canvas changed and changed back: one more revision, so the saved file follows.
            if (canvas.revision !== revisionBefore) canvas.revision += 1;
          } catch (error) {
            answer.rollbackError = describe(error);
          }
        } else {
          if (draft) {
            const marked = current.store.allRecords().filter((r) => r.typeName === 'shape' && draftOf(r)?.id === draft.id).length;
            answer.draft = { id: draft.id, shapes: marked, from: revisionBefore };
          }
          try {
            reveal(editor, drawn);
          } catch {
            // Showing the drawing is a courtesy; the call's answer never depends on it.
          }
        }
      }
      const saved = await save();
      const savedAs = saved.ok ? { sourceRevision: saved.sourceRevision ?? undefined } : { saveError: saved.error };
      // Whether the call left the canvas changed: a lookup, or a call that was undone, did not.
      const changed = answer.ok === true && canvas.revision !== revisionBefore;
      ws.send(JSON.stringify({ id: message.id, ...answer, changed, revision: canvas.revision, ...savedAs }));
      // The server records the job when it reads this answer; show it a moment later.
      setTimeout(() => void refreshJobs(), 200);
      if (current) showDrafts(current);
    };
    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type !== 'exec') return;
      calls = calls.then(() => run(message)).catch(() => undefined);
    };
  };
  open();
}

// The left panel (fourth order, step 5): Timmy's canvas jobs, newest first, each linked to the receipt
// page of the turn that ran it once sealed, and the job of a selected shape marked; and "New board":
// a blank board, or a public template opened blank (its title, and an empty frame per capability).
const el = (tag, text, props = {}) => Object.assign(document.createElement(tag), text === undefined ? {} : { textContent: text }, props);
let jobs = [];
function selectedJobs(editor) {
  return new Set(editor.getSelectedShapes().map((shape) => shape.meta?.timmyJob).filter(Boolean));
}
/** A job's time: the clock time when it is today's, the date and time when it is older. The full time is the tooltip. */
function jobTime(at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return { text: String(at), iso: String(at) };
  const today = new Date().toDateString() === when.toDateString();
  const text = today
    ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return { text, iso: at };
}
/** What the Canvas row said the last time it could not show a job (no shapes of it on this page), by job. */
const jobNotes = new Map();
/**
 * The Canvas row of a job: its shapes, selected and brought into view. A job that left no shape on this
 * page (it drew nothing, or the shapes were deleted, or they are on another page) says so.
 */
function showJob(editor, id) {
  const shapes = editor.getCurrentPageShapes().filter((shape) => shape.meta?.timmyJob === id).map((shape) => shape.id);
  if (shapes.length === 0) {
    jobNotes.set(id, 'no shapes of this job on this page');
  } else {
    jobNotes.delete(id);
    editor.select(...shapes);
    reveal(editor, shapes);
  }
  showJobs(editor);
}
// The panel names each job in the words the REPL uses after a turn: its outcome and time, then Canvas
// (the job and the revision it left) and Receipt (its page, or "not linked yet").
function showJobs(editor) {
  const list = document.getElementById('job-list');
  const marked = selectedJobs(editor);
  const rows = jobs.slice(0, 12).map((job) => {
    const li = el('li', undefined, { className: 'job' });
    li.dataset.job = job.id;
    li.setAttribute('aria-current', String(marked.has(job.id)));
    const when = jobTime(job.at);
    const head = el('div', undefined, { className: 'job-head' });
    head.append(el('span', job.ok ? '✓ done' : '✖ failed', { className: `job-state ${job.ok ? 'ok' : 'bad'}` }));
    if (when.text) head.append(el('time', when.text, { dateTime: when.iso, title: when.iso }));
    // Round R1: a job's mark is its last call's; the calls that failed before it kept nothing, and say so.
    if (typeof job.failed === 'number' && job.failed > 0) head.append(el('span', `${job.failed} failed ${job.failed === 1 ? 'call' : 'calls'}, nothing kept`, { className: 'job-failed' }));
    const canvasRow = el('div', undefined, { className: 'job-row' });
    canvasRow.dataset.row = 'Canvas';
    const show = el('button', `job ${job.id}, rev ${job.revision}`, { type: 'button', className: 'job-show', title: 'Select what this job drew' });
    show.addEventListener('click', () => showJob(editor, job.id));
    canvasRow.append(el('span', 'Canvas', { className: 'k' }), ' ', show);
    const note = jobNotes.get(job.id);
    if (note) canvasRow.append(el('span', note, { className: 'job-note' }));
    const receiptRow = el('div', undefined, { className: 'job-row' });
    receiptRow.dataset.row = 'Receipt';
    receiptRow.append(
      el('span', 'Receipt', { className: 'k' }),
      ' ',
      job.receipt ? el('a', job.receipt, { href: `/receipts/${encodeURIComponent(job.receipt)}`, target: '_blank', rel: 'noopener' }) : el('span', 'not linked yet'),
    );
    li.append(head, canvasRow, receiptRow);
    return li;
  });
  list.replaceChildren(...(rows.length ? rows : [el('li', 'No jobs yet. Ask Timmy in the REPL to draw something.')]));
}
async function refreshJobs() {
  try {
    // R4 (H83): read with this page's session; none read keeps the last list
    const listed = await cards.jobs();
    if (listed) jobs = listed;
  } catch {
    // The status line already says when Timmy cannot be reached.
  }
  if (current) showJobs(current);
}
function showGuide(editor) {
  document.getElementById('guide').hidden = editor.getCurrentPageShapes().length > 0;
}

// ── R5 (H133): drafts in the side panel: each pending draft with Show, Accept and Discard ───────────────────────────────
/** The decisions made on this page, waiting for their save to land before they are recorded (then sent and dropped). */
const decisions = [];
let draftsShown = '';
function showDrafts(editor) {
  const pending = pendingDrafts(editor.store.allRecords());
  const key = JSON.stringify(pending.map((d) => [d.id, d.shapes.length, d.pages]));
  if (key === draftsShown) return;
  draftsShown = key;
  const box = document.getElementById('drafts');
  const list = document.getElementById('draft-list');
  box.hidden = pending.length === 0;
  document.getElementById('drafts-count').textContent = pending.length === 1 ? '1 waiting for you' : `${pending.length} waiting for you`;
  const pageName = (id) => editor.getPage(id)?.name ?? 'another page';
  list.replaceChildren(...pending.map((d) => {
    const li = el('li', undefined, { className: 'draft' });
    li.dataset.draft = d.id;
    li.append(el('p', draftLine(d), { className: 'draft-line' }));
    const here = d.pages.includes(editor.getCurrentPageId());
    if (!here) li.append(el('p', `On ${d.pages.map(pageName).join(', ')}.`, { className: 'draft-where' }));
    const acts = el('div', undefined, { className: 'draft-acts' });
    const show = el('button', 'Show', { type: 'button', className: 'draft-show', title: 'Selects the draft\'s shapes and brings them into view' });
    const accept = el('button', 'Accept', { type: 'button', className: 'draft-accept', title: 'Keeps the draft\'s shapes on the board and clears their draft mark. Nothing runs: no tool, job or file but the canvas.' });
    const discard = el('button', 'Discard', { type: 'button', className: 'draft-discard', title: 'Removes the draft\'s shapes from the board. Nothing runs: no tool, job or file but the canvas.' });
    // a decision is the person's: only a click the browser marks as theirs (a pointer, or Enter or Space on the focused button)
    // decides; code on the page (the agent's own calls run here) calling .click() on Accept decides nothing
    show.addEventListener('click', () => showDraft(d.id));
    accept.addEventListener('click', (e) => { if (e.isTrusted === true) decide(d.id, 'accepted'); });
    discard.addEventListener('click', (e) => { if (e.isTrusted === true) decide(d.id, 'discarded'); });
    acts.append(show, accept, discard);
    li.append(acts);
    return li;
  }));
}
function showDraft(id) {
  const editor = current;
  if (!editor) return;
  const d = pendingDrafts(editor.store.allRecords()).find((x) => x.id === id);
  if (!d) return;
  if (!d.pages.includes(editor.getCurrentPageId()) && d.pages[0]) editor.setCurrentPage(d.pages[0]);
  const here = d.shapes.filter((s) => editor.getAncestorPageId(s) === editor.getCurrentPageId());
  editor.select(...here);
  reveal(editor, here);
}
/**
 * R5 (H133): a person's decision on draft `id`: Accept clears its mark (its shapes stay), Discard removes its shapes (and assets
 * no other shape shows; the person's own shapes inside them are moved out first). Either is one undo step, saved through the
 * normal revision-checked save, and recorded once that save lands (flushDecisions). Nothing else runs.
 */
function decide(id, decision) {
  const editor = current;
  if (!editor) return;
  const records = editor.store.allRecords();
  const d = pendingDrafts(records).find((x) => x.id === id);
  if (!d) { band('That draft is no longer on the board.', true); showDrafts(editor); return; }
  editor.markHistoryStoppingPoint(`timmy ${decision} ${id}`);
  if (decision === 'accepted') {
    const next = acceptPlan(records, id);
    editor.run(() => editor.store.put(next));
  } else {
    const plan = discardPlan(records, id);
    editor.run(() => {
      for (const [child, parent] of Object.entries(plan.keepOut)) editor.reparentShapes([child], parent);
      editor.deleteShapes(plan.shapes);
      if (plan.assets.length) editor.deleteAssets(plan.assets);
    });
  }
  // recorded once a save holds it: a save already on its way when the person decided does not (`made`, the revision it left)
  decisions.push({ record: { draft: id, decision, shapes: d.shapes.length, job: d.job, from: d.from, at: new Date().toISOString() }, made: canvas.revision });
  band(decisionWords(decision, d, null));
  showDrafts(editor);
  void save();
}
/** R5 (H133): every decision whose save has landed, recorded with the revision and source revision that save produced. */
async function flushDecisions(saved) {
  while (decisions.length && decisions[0].made <= saved.revision) {
    const next = decisions[0].record;
    const body = { ...next, revision: saved.revision, sourceRevision: saved.sourceRevision };
    let r;
    try { r = await cards.draftDecision(body); } catch { r = { ok: false }; }
    if (!r.ok) { band(`${decisionWords(next.decision, { count: next.shapes, job: next.job }, saved)} The record of it was not written (Timmy answered ${r.status ?? 'nothing'}); it is tried again with the next save.`, true); return; }
    decisions.shift();
    band(decisionWords(next.decision, { count: next.shapes, job: next.job }, saved));
  }
}

/** R5 (H133): the outline and label of each pending draft on the page shown, in front of the canvas (never taking a click). */
function DraftMarks() {
  const editor = useEditor();
  const marks = useValue('timmy: drafts on this page', () => {
    const groups = new Map();
    for (const shape of editor.getCurrentPageShapes()) {
      const d = draftOf(shape);
      if (!d) continue;
      const b = editor.getShapePageBounds(shape.id);
      if (!b) continue;
      const g = groups.get(d.id) ?? { id: d.id, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      g.minX = Math.min(g.minX, b.minX); g.minY = Math.min(g.minY, b.minY); g.maxX = Math.max(g.maxX, b.maxX); g.maxY = Math.max(g.maxY, b.maxY);
      groups.set(d.id, g);
    }
    const pad = 10;
    return [...groups.values()].map((g) => {
      const a = editor.pageToViewport({ x: g.minX, y: g.minY });
      const z = editor.pageToViewport({ x: g.maxX, y: g.maxY });
      return { id: g.id, x: Math.round(a.x - pad), y: Math.round(a.y - pad), w: Math.round(z.x - a.x + 2 * pad), h: Math.round(z.y - a.y + 2 * pad) };
    });
  }, [editor]);
  const h = React.createElement;
  return h(React.Fragment, null, ...marks.map((m) => h('div', { key: m.id, className: 'timmy-draft-mark', 'data-draft': m.id, style: { left: `${m.x}px`, top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` } },
    h('span', { className: 'timmy-draft-label' }, DRAFT_LABEL))));
}

/** R5 (H133): tldraw's main menu without its color-scheme choice: Timmy Canvas is dark only (DESIGN.md §10 B10). */
function TimmyMainMenu() {
  const h = React.createElement;
  return h(DefaultMainMenu, null,
    h(TldrawUiMenuGroup, { id: 'basic' }, h(EditSubmenu), h(ViewSubmenu), h(ExportFileContentSubMenu), h(ExtrasGroup)),
    h(TldrawUiMenuGroup, { id: 'preferences' },
      h(TldrawUiMenuSubmenu, { id: 'preferences', label: 'menu.preferences' },
        h(TldrawUiMenuGroup, { id: 'preferences-actions' }, h(ToggleSnapModeItem), h(ToggleToolLockItem), h(ToggleGridItem), h(ToggleWrapModeItem), h(ToggleFocusModeItem), h(ToggleEdgeScrollingItem), h(ToggleDynamicSizeModeItem), h(TogglePasteAtCursorItem), h(ToggleDebugModeItem)),
        h(TldrawUiMenuGroup, { id: 'user-interface-submenus' }, h(AccessibilityMenu), h(InputModeMenu))),
      h(LanguageMenu), h(KeyboardShortcutsMenuItem)));
}

/** R5 (H133): the page's CSS variable `name` (Timmy's shared look), or `fallback`. */
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/** A new page: blank, or a public template as an empty board (a frame named for it, an empty frame per capability). */
function openBoard(editor, template) {
  const names = new Set(editor.getPages().map((p) => p.name));
  let name = template ? template.title : 'Blank board';
  for (let n = 2; names.has(name); n += 1) name = `${template ? template.title : 'Blank board'} ${n}`;
  const page = editor.createPage({ name }).getPages().find((p) => p.name === name);
  editor.setCurrentPage(page.id);
  if (template && Array.isArray(template.frames)) {
    openGuided(editor, template);
  } else if (template) {
    const frame = createShapeId();
    const slot = { w: 320, h: 220, gap: 24 };
    const across = Math.min(3, template.caps.length);
    const down = Math.ceil(template.caps.length / across);
    editor.createShape({ id: frame, type: 'frame', x: 0, y: 0, props: { name: template.title, w: across * (slot.w + slot.gap) + slot.gap, h: down * (slot.h + slot.gap) + slot.gap } });
    editor.createShapes(template.caps.map((cap, i) => ({
      id: createShapeId(), type: 'frame', parentId: frame,
      x: slot.gap + (i % across) * (slot.w + slot.gap), y: slot.gap + Math.floor(i / across) * (slot.h + slot.gap),
      props: { name: cap, w: slot.w, h: slot.h },
    })));
    fitBeside(editor);
  }
  showGuide(editor);
}
/**
 * R5 (H133): a board just opened, fitted into the area beside Timmy's panel (or below it on a phone), never closer than 100 %:
 * zoomToFit alone fitted it to the whole window, and its left part sat under the panel.
 */
function fitBeside(editor, o = {}) {
  editor.zoomToFit();
  const z = editor.getCamera().z;
  if (z > 1) editor.setCamera({ ...editor.getCamera(), z: 1 });
  try { reveal(editor, editor.getCurrentPageShapes().map((s) => s.id), o); } catch { /* showing it is a courtesy */ }
}
/**
 * R5 (H133): a canvas reopened (loaded, or reloaded from disk) shows what it holds: its shapes fitted into the area beside Timmy's
 * panel and under the workspace strip, never closer than 100 % (the camera is not saved with the canvas, so it had opened at the
 * origin: a shape cut by the top edge, the others under the panel). A blank page stays as it is.
 */
function fitOnOpen(editor) {
  if (!editor || editor.getCurrentPageShapes().length === 0) return;
  // the canvas box as it is laid out now (it starts under the strip), before the fit reads it
  try { editor.updateViewportScreenBounds(editor.getContainer()); } catch { /* tldraw keeps its own */ }
  fitBeside(editor, { now: true });
}
/**
 * R5 (H133): a guided blank board (src/studio/templates.ts guidedTemplates): its title and what it is for, then one empty frame
 * per part, each holding a line that says what goes in it. Text and empty frames only: no image, sample, metric or asset. A flow
 * board's frames are joined left to right by arrows, in order. Every shape keeps the template's id in its meta.
 */
function openGuided(editor, t) {
  const slot = { w: 340, h: 250, gap: 56 };
  const across = Math.max(1, Math.min(t.frames.length, t.columns || 3));
  const width = across * slot.w + (across - 1) * slot.gap;
  const meta = (part) => ({ timmyTemplate: t.id, timmyGuide: part });
  const title = createShapeId();
  const intro = createShapeId();
  editor.createShapes([
    { id: title, type: 'text', x: 0, y: -210, props: { richText: toRichText(t.title), size: 'l', font: 'sans', autoSize: true }, meta: meta('title') },
    { id: intro, type: 'text', x: 0, y: -140, props: { richText: toRichText(t.intro), size: 's', font: 'sans', color: 'grey', autoSize: false, w: Math.min(width, 900) }, meta: meta('intro') },
  ]);
  const frames = t.frames.map(() => createShapeId());
  editor.createShapes(t.frames.flatMap((f, i) => {
    const x = (i % across) * (slot.w + slot.gap);
    const y = Math.floor(i / across) * (slot.h + slot.gap);
    return [
      { id: frames[i], type: 'frame', x, y, props: { name: f.name, w: slot.w, h: slot.h }, meta: meta('frame') },
      { id: createShapeId(), type: 'text', parentId: frames[i], x: 16, y: 16, props: { richText: toRichText(f.guide), size: 's', font: 'sans', color: 'grey', autoSize: false, w: slot.w - 32 }, meta: meta('hint') },
    ];
  }));
  if (t.flow) {
    for (let i = 0; i + 1 < frames.length; i += 1) {
      if (Math.floor(i / across) !== Math.floor((i + 1) / across)) continue;
      const a = editor.getShapePageBounds(frames[i]);
      const b = editor.getShapePageBounds(frames[i + 1]);
      if (!a || !b) continue;
      const arrow = createShapeId();
      const y = a.minY + a.h / 2;
      editor.createShape({ id: arrow, type: 'arrow', x: a.maxX, y, props: { start: { x: 0, y: 0 }, end: { x: b.minX - a.maxX, y: 0 }, color: 'grey' }, meta: meta('flow') });
      editor.createBindings([
        { type: 'arrow', fromId: arrow, toId: frames[i], props: { terminal: 'start', normalizedAnchor: { x: 1, y: 0.5 }, isExact: false, isPrecise: true } },
        { type: 'arrow', fromId: arrow, toId: frames[i + 1], props: { terminal: 'end', normalizedAnchor: { x: 0, y: 0.5 }, isExact: false, isPrecise: true } },
      ]);
    }
  }
  editor.selectNone();
  fitBeside(editor);
}
async function offerBoards() {
  const pick = document.getElementById('board-pick');
  let templates = [];
  let guided = [];
  try {
    const response = await fetch('/api/canvas/templates', { cache: 'no-store' });
    if (response.ok) {
      const listed = await response.json();
      templates = listed.templates ?? [];
      guided = listed.guided ?? [];
    }
  } catch {
    // Without the list, New board still opens a blank board.
  }
  // R5 (H133): the guided blank boards first (each says what goes where), then the seeds (a frame per capability)
  if (guided.length) {
    const group = el('optgroup', undefined, { label: 'Guided, blank' });
    group.append(...guided.map((t) => el('option', t.title, { value: t.id })));
    pick.append(group);
  }
  if (templates.length) {
    const group = el('optgroup', undefined, { label: 'Seeds, blank' });
    group.append(...templates.map((t) => el('option', `${t.title} (${t.domain})`, { value: t.id })));
    pick.append(group);
  }
  const all = [...guided, ...templates];
  document.getElementById('board-open').addEventListener('click', () => current && openBoard(current, all.find((t) => t.id === pick.value)));
}
/** The panel's own parts, once per page: the jobs list, New board, and the jobs' refresh. */
function connectPanel() {
  document.getElementById('side-ready').hidden = false;
  watchEdge(document.getElementById('side-scroll'));
  // On a narrow screen the jobs start folded, so the panel leaves the canvas room.
  if (window.innerWidth < 600) document.getElementById('jobs').open = false;
  void offerBoards();
  void refreshJobs();
  // R5 (H133): the save's Retry and the recovery box's buttons
  document.getElementById('save-retry').addEventListener('click', () => { canvas.failed = null; void save(); });
  document.getElementById('conflict-reload').addEventListener('click', () => void reloadFromDisk());
  document.getElementById('conflict-keep').addEventListener('click', () => void keepCopy());
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void refreshJobs();
    void checkDisk();
  }, 5000);
  // Round R4 (H55): the project the REPL named, as cards to place on the canvas (./project.js). R4 (H75): read with each card's
  // drawn detail, which the drawn cards follow; Place card makes one; the reading comes faster while a card's job runs.
  // R4 (H81): read through the drawn cards' own reader: the cards' detail only with this page's session (./cards.js read), and
  // the line under the panel follows the session (a session that ended is said so).
  const acts = document.getElementById('project-acts');
  const showSession = () => { const s = cards.session(); acts.textContent = s.words; acts.dataset.kind = s.state; };
  projectPanel = createProjectPanel({
    editor: () => current, toRichText, createShapeId, place: placeAt, reveal,
    // R4 (H109): a board pinned to a project reads that project (its id); a following board, the project the canvas shows
    read: (pinned) => cards.read(pinned), onAnswer: (now) => { cards.onAnswer(now); showSession(); }, fast: () => cards.wantsFast(),
    drawable: (kind) => drawnType(kind) !== null, placeCard: (id, now) => cards.place(id, now),
    // R4 (H100): Place this operation (its cards at once, left to right in the order they ran, linked)
    placeOperation: (id, now) => cards.placeOperation(id, now),
    // R4 (H109): an operation group's Run detail
    runDetail: (op, projectId) => showRunDetail(op, projectId),
  });
  cards.setPoll(() => projectPanel.poll());
  // R4 (H88; r23): the line follows the session as soon as it changes (a refused save, a refused reading, a session ended)
  cards.setSessionListener(showSession);
  showSession();
  if (current) showDrafts(current);
}

// Round R4 (H55): where a placed project card goes: the middle of the area beside Timmy's panel, each next one a step
// lower and to the right, so cards placed one after another do not cover each other. R4 (H88; the Mac run r23): the card's
// own size (`size`, in page units: a note's 200 x 200 by default, a drawn card's width) is kept inside that area at the
// camera's zoom, its left and top edges never before the area's (it had been placed by a 200-wide note's middle).
let projectPanel = null;
function placeAt(editor, size = { w: 200, h: 200 }) {
  const area = freeArea();
  const z = editor.getCamera().z || 1;
  const x = area.x + Math.max(0, (area.w - size.w * z) / 2);
  const y = area.y + Math.max(0, (area.h - size.h * z) / 2);
  const at = editor.screenToPage({ x, y });
  const placed = editor.getCurrentPageShapes().filter((shape) => shape.meta?.timmyProjectCard).length % 6;
  return { x: Math.round(at.x + placed * 24), y: Math.round(at.y + placed * 24) };
}
/**
 * The agent's canvas_place_project_card (src/agent/canvas-tools.ts) calls this with the card's id, which reached the page
 * only as a JSON string. With no id it changes nothing and lists the project's cards.
 */
async function placeProjectCard(id, editor = current) {
  if (!projectPanel) throw new Error('The project panel is not ready yet: reload the canvas page.');
  if (id === undefined || id === null || id === '') {
    // R4 (H83): the cards are read with this page's session (the drawn cards' own reader)
    const now = await cards.read();
    return { project: now.project ? now.project.name : null, ...(now.message ? { message: now.message } : {}), cards: (now.cards || []).map((c) => ({ id: c.id, kind: c.kind, title: c.title, state: c.state })) };
  }
  return projectPanel.place(String(id), editor);
}
/** What the panel follows in each editor: the blank-board guide and the selected shapes' jobs. */
function followEditor(editor) {
  let queued = false;
  editor.store.listen(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (current !== editor) return;
      showGuide(editor);
      showJobs(editor);
      // R5 (H133): the pending drafts follow the board (a person's own deletes and undo included)
      if (document.getElementById('side-ready').hidden === false) showDrafts(editor);
      // R4 (H109): another board shown (or a board's pin changed): the panel reads for it at once
      try { projectPanel?.boardChanged(); } catch { /* the next reading follows */ }
    });
  });
  draftsShown = '';
  showGuide(editor);
  showJobs(editor);
}

/** Props every mount of tldraw shares; set once the server's settings are read. */
let tldrawProps = null;
let reactRoot = null;
let mounts = 0;
/** Start tldraw on `snapshot` (a fresh editor each time); resolves once it has mounted and Timmy is attached. */
function mount(snapshot) {
  mounts += 1;
  return new Promise((resolve) => {
    reactRoot.render(
      React.createElement(Tldraw, {
        ...tldrawProps,
        key: `timmy-canvas-${mounts}`,
        snapshot,
        onMount: (editor) => {
          current = editor;
          editor.user.updateUserPreferences({ colorScheme: 'dark' });
          // Timmy's agent bridge (F-4, slice 2) drives the canvas through this handle. R4 (H55): with the project's cards.
          window.timmyCanvas = {
            editor, tldrawVersion: BUILT_WITH, licenseState: window.timmyCanvas?.licenseState ?? 'pending', document: canvas, mounts,
            placeProjectCard, refreshProjectCards: () => (projectPanel ? projectPanel.refreshAll() : Promise.reject(new Error('The project panel is not ready yet.'))),
            // R4 (H75): a drawn card of the project (it places a shape; its buttons act only for a person's click on them, R4 H81)
            placeDrawnCard: (id) => (projectPanel ? projectPanel.placeCard(String(id)) : Promise.reject(new Error('The project panel is not ready yet.'))),
            // R4 (H100): an operation's cards at once, as the panel's Place this operation does (shapes only: nothing runs)
            placeOperation: (id) => (projectPanel ? projectPanel.placeOperation(String(id)) : Promise.reject(new Error('The project panel is not ready yet.'))),
            // R5 (H133): the pending drafts, as the panel lists them (read only; Accept and Discard are the panel's buttons)
            drafts: () => pendingDrafts(editor.store.allRecords()),
          };
          attachEditor(editor);
          followEditor(editor);
          showStatus(editor);
          // R5 (H137): the panel ends just above what tldraw draws under it
          watchFoot();
          resolve(editor);
        },
      }),
    );
  });
}

/**
 * R4 (H83): a page without a session that counts (opened by its address, a bookmark or a reload, or its grant refused) loads no
 * canvas: it says so plainly in the middle of the page, with the command that opens one, and the status says where (R5 H133);
 * nothing else starts.
 */
function refuseToLoad(words) {
  // R5 (H133): said once, in the middle of the page (why, and what to type); the panel's line points there (it had the same
  // paragraph twice). No workspace strip: the page has no session to read it with.
  say('Not loaded: why, and what to type in Timmy, are in the middle of the page.', 'refused');
  document.getElementById('refused-words').textContent = words;
  document.getElementById('refused').hidden = false;
  hideFrame();
}

/**
 * R5 (H133): the workspace strip (index.html #frame), shown at once on a page Timmy opened, so the canvas starts below it before
 * tldraw lays out; its height is the canvas box's top (--frame-h), followed as it changes (a narrow window, a longer line).
 */
let frameStrip = null;
function showFrame() {
  const strip = document.getElementById('frame');
  if (!strip) return;
  strip.hidden = false;
  const follow = () => document.documentElement.style.setProperty('--frame-h', `${strip.hidden ? 0 : Math.ceil(strip.getBoundingClientRect().height)}px`);
  follow();
  if (typeof ResizeObserver === 'function') new ResizeObserver(follow).observe(strip);
}
function hideFrame() {
  const strip = document.getElementById('frame');
  if (strip) strip.hidden = true;
  document.documentElement.style.setProperty('--frame-h', '0px');
  frameStrip?.stop();
  frameStrip = null;
}
/** R5 (H133): reads the frame with this page's session, now and every few seconds while the page is shown (./frame.js). */
function startFrame() {
  const strip = document.getElementById('frame');
  if (!strip || frameStrip) return;
  frameStrip = createFrameStrip({ root: strip, read: () => cards.workspace() });
}

/**
 * R5 (H137; the rehearsal: the panel's list ended 116 px above the window's foot, with room below it, on a wide window): where
 * the panel may end (index.html #side, --side-foot): 8 px above the highest of tldraw's own bottom parts that sit under the panel
 * (its navigation panel and minimap on a wide window; its toolbar and the row of actions over it on a narrow one), else 8 px above
 * the window's foot. Measured once tldraw has laid them out, and again as they or the window change size.
 */
const FOOT_PARTS = '.tlui-navigation-panel, .tlui-minimap, .tlui-main-toolbar__inner, .tlui-help-menu';
let footWatch = null;
function measureFoot() {
  const side = document.getElementById('side');
  if (!side) return;
  const s = side.getBoundingClientRect();
  let top = window.innerHeight;
  for (const part of document.querySelectorAll(FOOT_PARTS)) {
    const b = part.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || b.right <= s.left || b.left >= s.right || b.top >= window.innerHeight) continue;
    top = Math.min(top, b.top);
  }
  const foot = `${Math.max(8, Math.ceil(window.innerHeight - top) + 8)}px`;
  if (document.documentElement.style.getPropertyValue('--side-foot') !== foot) document.documentElement.style.setProperty('--side-foot', foot);
}
function watchFoot() {
  if (!footWatch) {
    footWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measureFoot()) : { observe() {}, disconnect() {} };
    window.addEventListener('resize', () => requestAnimationFrame(measureFoot), { passive: true });
  }
  // tldraw lays its parts out after it mounts (and again for each board): they are looked for over the next frames, each watched
  footWatch.disconnect();
  let frames = 0;
  const look = () => {
    for (const part of document.querySelectorAll(`${FOOT_PARTS}, .tlui-layout__bottom`)) footWatch.observe(part);
    measureFoot();
    frames += 1;
    if (frames < 30 || (!document.querySelector('.tlui-main-toolbar__inner') && frames < 240)) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

/**
 * R5 (H133): the panel's scroll region marks when more of it is below its edge (data-more="below": index.html fades that edge),
 * as it scrolls, resizes and its lists change.
 */
function watchEdge(region) {
  if (!region) return;
  const mark = () => {
    const below = region.scrollTop + region.clientHeight < region.scrollHeight - 2;
    const was = region.dataset.more;
    const now = below ? 'below' : 'none';
    if (was !== now) region.dataset.more = now;
  };
  region.addEventListener('scroll', mark, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(mark).observe(region);
  if (typeof MutationObserver === 'function') new MutationObserver(mark).observe(region, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden'] });
  mark();
}

async function start() {
  // R4 (H75): this page's grant becomes its session before anything else (before tldraw starts and before the agent's bridge
  // connects). R4 (H83): the canvas, its settings' license and its jobs are read only with it, so without one nothing loads.
  say(GRANT_AT_LOAD ? 'Loading the canvas: opening this page\'s session with Timmy' : 'Loading the canvas', 'loading');
  // R5 (H133): a page Timmy opened draws the workspace strip at once (its space is kept before tldraw lays out below it)
  if (GRANT_AT_LOAD) showFrame();
  const session = await cards.startSession();
  if (session.state !== 'ok') { refuseToLoad(session.words); return; }
  startFrame();
  say('Loading the canvas: reading its settings from Timmy', 'loading');
  const settings = await cards.config();
  if (!settings.ok || !settings.body) throw new Error(`Timmy answered ${settings.status} for the canvas settings`);
  const config = settings.body;
  if (config.tldrawVersion !== BUILT_WITH) {
    throw new Error(`this canvas was built with tldraw ${BUILT_WITH}, but Timmy pins ${config.tldrawVersion}. Rebuild it: npm run build:canvas`);
  }
  // The folder this server saves the canvas in, TIMMY_HOME included; the blank board names it.
  if (typeof config.canvasDir === 'string' && config.canvasDir) document.getElementById('guide-dir').textContent = config.canvasDir;
  say('Loading the canvas: opening the saved canvas', 'loading');
  const opened = await cards.loadDocument();
  if (opened.status === 401 || opened.status === 0) { refuseToLoad(opened.why || 'Timmy refused this page the canvas.'); return; }
  if (!opened.ok || !opened.body) throw new Error(`Timmy answered ${opened.status} for the saved canvas`);
  const saved = opened.body;
  canvas.revision = saved.revision;
  canvas.savedRevision = saved.revision;
  canvas.sourceRevision = saved.sourceRevision;
  canvas.savedAt = saved.savedAt ?? null;
  canvas.notice = saved.notice ?? null;
  say('Loading the canvas: starting tldraw', 'loading');
  tldrawProps = {
    // R4 (H75): Timmy's drawn cards beside tldraw's own shapes
    shapeUtils: cards.utils,
    licenseKey: config.licenseKey ?? undefined,
    // tldraw's fonts, icons, translations and embed icons, served by Timmy beside this bundle.
    assetUrls: getAssetUrls({ baseUrl: new URL('assets/', import.meta.url).href }),
    // R5 (H133): dark only, on B10: the canvas colors from Timmy's shared look (./theme.js), the chrome from index.html's
    // variables; tldraw's palette for what is drawn stays tldraw's. The color-scheme choice is left out of the menu, and its
    // shortcut with it.
    themes: timmyThemes(DEFAULT_THEME, cssVar),
    colorScheme: 'dark',
    overrides: { actions: (_editor, actions) => { const { 'toggle-dark-mode': _dark, ...kept } = actions; return kept; } },
    // R5 (H133): a pending draft's outline and label, in front of the canvas; the main menu without the color scheme
    components: { InFrontOfTheCanvas: DraftMarks, MainMenu: TimmyMainMenu },
  };
  reactRoot = createRoot(document.getElementById('root'));
  // The saved canvas from Timmy's home; none means a blank one.
  await mount(saved.snapshot ? { document: saved.snapshot } : undefined);
  // R5 (H133): reopened, it shows what it holds, beside the panel and under the strip
  fitOnOpen(current);
  connectBridge();
  connectPanel();
  window.addEventListener('pagehide', () => saveOnLeave());
}

start().catch((error) => {
  say(`The canvas could not start: ${error instanceof Error ? error.message : String(error)}`, 'error');
});
