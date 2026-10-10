// Timmy Canvas (plan F-4): tldraw, pinned and bundled on this machine (fourth order, step 5),
// licensed from TLDRAW_LICENSE_KEY through the local server. scripts/canvas/build.mjs bundles this
// file with tldraw, React and tldraw's own fonts, icons, translations and embed icons into ../dist,
// so the canvas loads nothing from another host. The license key is never built in: the server
// hands it to the page at run time. The canvas itself is saved by Timmy, in its home, and opened
// from there: it reopens where it was, and the terminal reads the same document.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BaseBoxShapeUtil, Box, HTMLContainer, T, Tldraw, Vec, atom, createBindingId, createShapeId, getSnapshot, resizeBox, toRichText, useValue } from 'tldraw';
import { getAssetUrls } from '@tldraw/assets/selfHosted';
import 'tldraw/tldraw.css';
import { createProjectPanel } from './project.js';
import { createCards, drawnType } from './cards.js';

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
 * window saved first: this one then stops saving rather than overwrite it.
 */
const canvas = { revision: 0, savedRevision: 0, sourceRevision: null, conflict: null, notice: null, linked: false, timer: null };

/**
 * The live editor. A canvas call that crashes tldraw gets a fresh editor (round R1: see `restore`), so
 * everything that reaches the editor later (saves, the panel, the next call) goes through `current`,
 * never an editor kept from the first mount.
 */
let current = null;

// Round R4 (H75): Timmy Canvas's own drawn cards (workflow, parameter and result), and the session their actions go with.
const cards = createCards({
  React, BaseBoxShapeUtil, HTMLContainer, T, atom, useValue, resizeBox, createShapeId, grant: GRANT_AT_LOAD,
  editor: () => current, place: (editor) => placeAt(editor), reveal: (editor, ids) => reveal(editor, ids),
});

function showStatus(editor) {
  const state = editor.licenseManager?.state.get() ?? 'unknown';
  window.timmyCanvas.licenseState = state;
  if (canvas.conflict) {
    say(`Not saved: ${canvas.conflict}`, 'error');
    return;
  }
  const saved = canvas.revision === canvas.savedRevision ? `revision ${canvas.revision}, saved` : `revision ${canvas.revision}, saving`;
  const text = `Canvas ready · tldraw ${BUILT_WITH} · ${LICENSE[state] ?? `license state: ${state}`} · ${canvas.linked ? 'Timmy connected' : 'Timmy not connected'} · ${saved}`;
  say(canvas.notice ? `${canvas.notice} ${text}` : text, canvas.linked ? 'ready' : 'waiting');
  if (state === 'pending') setTimeout(() => current && showStatus(current), 250);
}

// Saves go one at a time, each from the revision the last one left on disk.
let queue = Promise.resolve();
async function saveNow() {
  const editor = current;
  if (canvas.conflict) return { ok: false, error: canvas.conflict };
  if (canvas.revision === canvas.savedRevision) return { ok: true, revision: canvas.revision, sourceRevision: canvas.sourceRevision };
  const revision = canvas.revision;
  let status = 0;
  let saved;
  try {
    const response = await fetch('/api/canvas/document', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: getSnapshot(editor.store).document, revision, baseRevision: canvas.savedRevision }),
    });
    status = response.status;
    saved = await response.json();
  } catch (error) {
    saved = { ok: false, error: `Timmy could not be reached to save the canvas (${error instanceof Error ? error.message : String(error)}).` };
  }
  if (saved.ok) {
    canvas.savedRevision = saved.revision;
    canvas.sourceRevision = saved.sourceRevision;
    canvas.notice = null;
  } else if (status === 409) {
    canvas.conflict = saved.error;
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
  if (!current || canvas.conflict || canvas.revision === canvas.savedRevision) return;
  clearTimeout(canvas.timer);
  const body = JSON.stringify({ snapshot: getSnapshot(current.store).document, revision: canvas.revision, baseRevision: canvas.savedRevision });
  fetch('/api/canvas/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60_000 }).catch(() => undefined);
}

// The agent bridge (F-4, slice 2): Timmy sends Editor API code; it runs here against the live editor
// and the answer goes back only after the canvas is saved, with the revision and the source revision
// of what was saved, so the terminal and the file agree on what the call produced. Calls run one at a
// time, and every shape created while a job's code runs carries that job's ID in meta.timmyJob.
const AsyncFunction = (async () => {}).constructor;
const MAX_ANSWER = 256 * 1024;
let runningJob = null;
let calls = Promise.resolve();
/** The shapes the running call has created, so they can be brought into view when it ends. */
let drawnInCall = null;

// What a call draws comes into view beside Timmy's panel, or below it when that leaves more room (a
// phone), above tldraw's toolbar (LIVE-01, ledger row 65: a rectangle drawn at (100, 100) sat hidden
// under the panel). A call that draws inside that area leaves the camera where it is.
function freeArea() {
  const margin = 16;
  const top = 56;
  const side = document.getElementById('side')?.getBoundingClientRect();
  const bar = document.querySelector('.tlui-main-toolbar')?.getBoundingClientRect();
  const bottom = (bar && bar.height > 0 ? bar.top : innerHeight - 72) - margin;
  if (!side || side.width === 0) return { x: margin, y: top, w: innerWidth - 2 * margin, h: bottom - top };
  const right = { x: side.right + margin, y: top, w: innerWidth - side.right - 2 * margin, h: bottom - top };
  const below = { x: margin, y: side.bottom + margin, w: innerWidth - 2 * margin, h: bottom - side.bottom - margin };
  return right.w * right.h >= below.w * below.h ? right : below;
}
function reveal(editor, ids) {
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
    { animation: { duration: 220 } },
  );
}

/** What every editor needs from Timmy: each shape a call creates carries the call's job, and every change counts and saves. */
function attachEditor(editor) {
  editor.sideEffects.registerBeforeCreateHandler('shape', (shape) => {
    drawnInCall?.add(shape.id);
    return runningJob ? { ...shape, meta: { ...shape.meta, timmyJob: runningJob } } : shape;
  });
  const bump = () => {
    canvas.revision += 1;
    saveSoon();
    if (current) showStatus(current);
  };
  for (const type of ['shape', 'binding', 'page', 'asset']) {
    editor.sideEffects.registerAfterCreateHandler(type, bump);
    editor.sideEffects.registerAfterChangeHandler(type, bump);
    editor.sideEffects.registerAfterDeleteHandler(type, bump);
  }
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

function connectBridge() {
  const helpers = { Box, Vec, createBindingId, createShapeId, toRichText };
  const open = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bridge`);
    ws.onopen = () => { canvas.linked = true; if (current) showStatus(current); };
    ws.onclose = () => { canvas.linked = false; if (current) showStatus(current); setTimeout(open, 2000); };
    const run = async (message) => {
      const editor = current;
      const before = getSnapshot(editor.store);
      const revisionBefore = canvas.revision;
      const mark = editor.markHistoryStoppingPoint(`timmy ${typeof message.jobId === 'string' ? message.jobId : 'call'}`);
      let answer;
      runningJob = typeof message.jobId === 'string' ? message.jobId : null;
      drawnInCall = new Set();
      try {
        const result = await new AsyncFunction('editor', 'helpers', message.code)(editor, helpers);
        const json = JSON.stringify(result === undefined ? null : result);
        answer = json.length > MAX_ANSWER
          ? { ok: false, error: `The result is too large to send back (${Math.round(json.length / 1024)} KB); return less.` }
          : { ok: true, result: JSON.parse(json) };
      } catch (error) {
        answer = { ok: false, error: describe(error) };
      } finally {
        runningJob = null;
      }
      const drawn = [...drawnInCall];
      drawnInCall = null;
      const crash = typeof editor.getCrashingError === 'function' ? editor.getCrashingError() : null;
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
        try {
          reveal(editor, drawn);
        } catch {
          // Showing the drawing is a courtesy; the call's answer never depends on it.
        }
      }
      const saved = await save();
      const savedAs = saved.ok ? { sourceRevision: saved.sourceRevision ?? undefined } : { saveError: saved.error };
      // Whether the call left the canvas changed: a lookup, or a call that was undone, did not.
      const changed = answer.ok === true && canvas.revision !== revisionBefore;
      ws.send(JSON.stringify({ id: message.id, ...answer, changed, revision: canvas.revision, ...savedAs }));
      // The server records the job when it reads this answer; show it a moment later.
      setTimeout(() => void refreshJobs(), 200);
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
    const response = await fetch('/api/canvas/jobs', { cache: 'no-store' });
    if (response.ok) jobs = await response.json();
  } catch {
    // The status line already says when Timmy cannot be reached.
  }
  if (current) showJobs(current);
}
function showGuide(editor) {
  document.getElementById('guide').hidden = editor.getCurrentPageShapes().length > 0;
}

/** A new page: blank, or a public template as an empty board (a frame named for it, an empty frame per capability). */
function openBoard(editor, template) {
  const names = new Set(editor.getPages().map((p) => p.name));
  let name = template ? template.title : 'Blank board';
  for (let n = 2; names.has(name); n += 1) name = `${template ? template.title : 'Blank board'} ${n}`;
  const page = editor.createPage({ name }).getPages().find((p) => p.name === name);
  editor.setCurrentPage(page.id);
  if (template) {
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
    editor.zoomToFit();
  }
  showGuide(editor);
}
async function offerBoards() {
  const pick = document.getElementById('board-pick');
  let templates = [];
  try {
    const response = await fetch('/api/canvas/templates', { cache: 'no-store' });
    if (response.ok) templates = (await response.json()).templates ?? [];
  } catch {
    // Without the list, New board still opens a blank board.
  }
  pick.append(...templates.map((t) => el('option', `${t.title} (${t.domain})`, { value: t.id })));
  document.getElementById('board-open').addEventListener('click', () => current && openBoard(current, templates.find((t) => t.id === pick.value)));
}
/** The panel's own parts, once per page: the jobs list, New board, and the jobs' refresh. */
function connectPanel() {
  document.getElementById('side-ready').hidden = false;
  // On a narrow screen the jobs start folded, so the panel leaves the canvas room.
  if (window.innerWidth < 600) document.getElementById('jobs').open = false;
  void offerBoards();
  void refreshJobs();
  setInterval(() => { if (document.visibilityState === 'visible') void refreshJobs(); }, 5000);
  // Round R4 (H55): the project the REPL named, as cards to place on the canvas (./project.js). R4 (H75): read with each card's
  // drawn detail, which the drawn cards follow; Place card makes one; the reading comes faster while a card's job runs.
  projectPanel = createProjectPanel({
    editor: () => current, toRichText, createShapeId, place: placeAt, reveal,
    detail: true, onAnswer: (now) => cards.onAnswer(now), fast: () => cards.wantsFast(),
    drawable: (kind) => drawnType(kind) !== null, placeCard: (id, now) => cards.place(id, now),
  });
  cards.setPoll(() => projectPanel.poll());
  const s = cards.session();
  const acts = document.getElementById('project-acts');
  acts.textContent = s.words;
  acts.dataset.kind = s.state;
}

// Round R4 (H55): where a placed project card goes: the middle of the area beside Timmy's panel, each next one a step
// lower and to the right, so cards placed one after another do not cover each other.
let projectPanel = null;
function placeAt(editor) {
  const area = freeArea();
  const middle = editor.screenToPage({ x: area.x + area.w / 2, y: area.y + area.h / 2 });
  const placed = editor.getCurrentPageShapes().filter((shape) => shape.meta?.timmyProjectCard).length % 6;
  return { x: Math.round(middle.x - 100 + placed * 24), y: Math.round(middle.y - 100 + placed * 24) };
}
/**
 * The agent's canvas_place_project_card (src/agent/canvas-tools.ts) calls this with the card's id, which reached the page
 * only as a JSON string. With no id it changes nothing and lists the project's cards.
 */
async function placeProjectCard(id, editor = current) {
  if (!projectPanel) throw new Error('The project panel is not ready yet: reload the canvas page.');
  if (id === undefined || id === null || id === '') {
    const response = await fetch('/api/project', { cache: 'no-store' });
    const now = await response.json();
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
    });
  });
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
            // R4 (H75): a drawn card of the project (it places a shape; acting needs a person's click on it)
            placeDrawnCard: (id) => (projectPanel ? projectPanel.placeCard(String(id)) : Promise.reject(new Error('The project panel is not ready yet.'))),
          };
          attachEditor(editor);
          followEditor(editor);
          showStatus(editor);
          resolve(editor);
        },
      }),
    );
  });
}

async function start() {
  say('Loading the canvas: reading its settings from Timmy', 'loading');
  const response = await fetch('/studio-config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Timmy answered ${response.status} for the canvas settings`);
  const config = await response.json();
  if (config.tldrawVersion !== BUILT_WITH) {
    throw new Error(`this canvas was built with tldraw ${BUILT_WITH}, but Timmy pins ${config.tldrawVersion}. Rebuild it: npm run build:canvas`);
  }
  // The folder this server saves the canvas in, TIMMY_HOME included; the blank board names it.
  if (typeof config.canvasDir === 'string' && config.canvasDir) document.getElementById('guide-dir').textContent = config.canvasDir;
  say('Loading the canvas: opening the saved canvas', 'loading');
  const opened = await fetch('/api/canvas/document', { cache: 'no-store' });
  if (!opened.ok) throw new Error(`Timmy answered ${opened.status} for the saved canvas`);
  const saved = await opened.json();
  canvas.revision = saved.revision;
  canvas.savedRevision = saved.revision;
  canvas.sourceRevision = saved.sourceRevision;
  canvas.notice = saved.notice ?? null;
  say('Loading the canvas: starting tldraw', 'loading');
  // R4 (H75): this page's grant becomes its session before tldraw starts (and before the agent's bridge connects).
  if (GRANT_AT_LOAD) say('Loading the canvas: opening this page\'s session with Timmy', 'loading');
  await cards.startSession();
  tldrawProps = {
    // R4 (H75): Timmy's drawn cards beside tldraw's own shapes
    shapeUtils: cards.utils,
    licenseKey: config.licenseKey ?? undefined,
    // tldraw's fonts, icons, translations and embed icons, served by Timmy beside this bundle.
    assetUrls: getAssetUrls({ baseUrl: new URL('assets/', import.meta.url).href }),
  };
  reactRoot = createRoot(document.getElementById('root'));
  // The saved canvas from Timmy's home; none means a blank one.
  await mount(saved.snapshot ? { document: saved.snapshot } : undefined);
  connectBridge();
  connectPanel();
  window.addEventListener('pagehide', () => saveOnLeave());
}

start().catch((error) => {
  say(`The canvas could not start: ${error instanceof Error ? error.message : String(error)}`, 'error');
});
