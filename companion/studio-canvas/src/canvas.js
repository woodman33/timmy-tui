// Timmy Canvas (plan F-4): tldraw, pinned and bundled on this machine (fourth order, step 5),
// licensed from TLDRAW_LICENSE_KEY through the local server. scripts/canvas/build.mjs bundles this
// file with tldraw, React and tldraw's own fonts, icons, translations and embed icons into ../dist,
// so the canvas loads nothing from another host. The license key is never built in: the server
// hands it to the page at run time. The canvas itself is saved by Timmy, in its home, and opened
// from there: it reopens where it was, and the terminal reads the same document.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Box, Tldraw, Vec, createBindingId, createShapeId, getSnapshot, toRichText } from 'tldraw';
import { getAssetUrls } from '@tldraw/assets/selfHosted';
import 'tldraw/tldraw.css';

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
  if (state === 'pending') setTimeout(() => showStatus(editor), 250);
}

// Saves go one at a time, each from the revision the last one left on disk.
let queue = Promise.resolve();
async function saveNow(editor) {
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
function save(editor) {
  clearTimeout(canvas.timer);
  const run = queue.then(() => saveNow(editor));
  queue = run.catch(() => undefined);
  return run;
}
const saveSoon = (editor) => {
  clearTimeout(canvas.timer);
  canvas.timer = setTimeout(() => save(editor), 400);
};

// The agent bridge (F-4, slice 2): Timmy sends Editor API code; it runs here against the live editor
// and the answer goes back only after the canvas is saved, with the revision and the source revision
// of what was saved, so the terminal and the file agree on what the call produced. Calls run one at a
// time, and every shape created while a job's code runs carries that job's ID in meta.timmyJob.
const AsyncFunction = (async () => {}).constructor;
const MAX_ANSWER = 256 * 1024;
let runningJob = null;
let calls = Promise.resolve();
function connectBridge(editor) {
  editor.sideEffects.registerBeforeCreateHandler('shape', (shape) =>
    runningJob ? { ...shape, meta: { ...shape.meta, timmyJob: runningJob } } : shape);
  const bump = () => {
    canvas.revision += 1;
    saveSoon(editor);
    showStatus(editor);
  };
  for (const type of ['shape', 'binding', 'page', 'asset']) {
    editor.sideEffects.registerAfterCreateHandler(type, bump);
    editor.sideEffects.registerAfterChangeHandler(type, bump);
    editor.sideEffects.registerAfterDeleteHandler(type, bump);
  }
  const helpers = { Box, Vec, createBindingId, createShapeId, toRichText };
  const open = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bridge`);
    ws.onopen = () => { canvas.linked = true; showStatus(editor); };
    ws.onclose = () => { canvas.linked = false; showStatus(editor); setTimeout(open, 2000); };
    const run = async (message) => {
      let answer;
      runningJob = typeof message.jobId === 'string' ? message.jobId : null;
      try {
        const result = await new AsyncFunction('editor', 'helpers', message.code)(editor, helpers);
        const json = JSON.stringify(result === undefined ? null : result);
        answer = json.length > MAX_ANSWER
          ? { ok: false, error: `The result is too large to send back (${Math.round(json.length / 1024)} KB); return less.` }
          : { ok: true, result: JSON.parse(json) };
      } catch (error) {
        answer = { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      } finally {
        runningJob = null;
      }
      const saved = await save(editor);
      const document = saved.ok ? { sourceRevision: saved.sourceRevision ?? undefined } : { saveError: saved.error };
      ws.send(JSON.stringify({ id: message.id, ...answer, revision: canvas.revision, ...document }));
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

async function start() {
  say('Loading the canvas: reading its settings from Timmy', 'loading');
  const response = await fetch('/studio-config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Timmy answered ${response.status} for the canvas settings`);
  const config = await response.json();
  if (config.tldrawVersion !== BUILT_WITH) {
    throw new Error(`this canvas was built with tldraw ${BUILT_WITH}, but Timmy pins ${config.tldrawVersion}. Rebuild it: npm run build:canvas`);
  }
  say('Loading the canvas: opening the saved canvas', 'loading');
  const opened = await fetch('/api/canvas/document', { cache: 'no-store' });
  if (!opened.ok) throw new Error(`Timmy answered ${opened.status} for the saved canvas`);
  const saved = await opened.json();
  canvas.revision = saved.revision;
  canvas.savedRevision = saved.revision;
  canvas.sourceRevision = saved.sourceRevision;
  canvas.notice = saved.notice ?? null;
  say('Loading the canvas: starting tldraw', 'loading');
  createRoot(document.getElementById('root')).render(
    React.createElement(Tldraw, {
      licenseKey: config.licenseKey ?? undefined,
      // tldraw's fonts, icons, translations and embed icons, served by Timmy beside this bundle.
      assetUrls: getAssetUrls({ baseUrl: new URL('assets/', import.meta.url).href }),
      // The saved canvas from Timmy's home; none means a blank one.
      snapshot: saved.snapshot ? { document: saved.snapshot } : undefined,
      onMount: (editor) => {
        editor.user.updateUserPreferences({ colorScheme: 'dark' });
        // Timmy's agent bridge (F-4, slice 2) drives the canvas through this handle.
        window.timmyCanvas = { editor, tldrawVersion: BUILT_WITH, licenseState: 'pending', document: canvas };
        showStatus(editor);
        connectBridge(editor);
      },
    }),
  );
}

start().catch((error) => {
  say(`The canvas could not start: ${error instanceof Error ? error.message : String(error)}`, 'error');
});
