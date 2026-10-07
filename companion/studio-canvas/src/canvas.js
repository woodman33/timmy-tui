// Timmy Canvas (plan F-4): tldraw, pinned and bundled on this machine (fourth order, step 5),
// licensed from TLDRAW_LICENSE_KEY through the local server. scripts/canvas/build.mjs bundles this
// file with tldraw, React and tldraw's own fonts, icons, translations and embed icons into ../dist,
// so the canvas loads nothing from another host. The license key is never built in: the server
// hands it to the page at run time.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Box, Tldraw, Vec, createBindingId, createShapeId, toRichText } from 'tldraw';
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
let linked = false;
function showLicense(editor, version) {
  const state = editor.licenseManager?.state.get() ?? 'unknown';
  window.timmyCanvas.licenseState = state;
  say(`Canvas ready · tldraw ${version} · ${LICENSE[state] ?? `license state: ${state}`} · ${linked ? 'Timmy connected' : 'Timmy not connected'}`, linked ? 'ready' : 'waiting');
  if (state === 'pending') setTimeout(() => showLicense(editor, version), 250);
}

// The agent bridge (F-4, slice 2): Timmy sends Editor API code; it runs here against the live editor
// and the answer goes back with the canvas revision: document changes (shapes, bindings, pages,
// assets, by Timmy or by hand) counted synchronously since the page opened, so it is exact when sent.
const AsyncFunction = (async () => {}).constructor;
const MAX_ANSWER = 256 * 1024;
function connectBridge(editor, version) {
  let revision = 0;
  const bump = () => { revision += 1; };
  for (const type of ['shape', 'binding', 'page', 'asset']) {
    editor.sideEffects.registerAfterCreateHandler(type, bump);
    editor.sideEffects.registerAfterChangeHandler(type, bump);
    editor.sideEffects.registerAfterDeleteHandler(type, bump);
  }
  const helpers = { Box, Vec, createBindingId, createShapeId, toRichText };
  const open = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bridge`);
    ws.onopen = () => { linked = true; showLicense(editor, version); };
    ws.onclose = () => { linked = false; showLicense(editor, version); setTimeout(open, 2000); };
    ws.onmessage = async (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type !== 'exec') return;
      let answer;
      try {
        const result = await new AsyncFunction('editor', 'helpers', message.code)(editor, helpers);
        const json = JSON.stringify(result === undefined ? null : result);
        answer = json.length > MAX_ANSWER
          ? { ok: false, error: `The result is too large to send back (${Math.round(json.length / 1024)} KB); return less.` }
          : { ok: true, result: JSON.parse(json) };
      } catch (error) {
        answer = { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      }
      ws.send(JSON.stringify({ id: message.id, ...answer, revision }));
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
  say('Loading the canvas: starting tldraw', 'loading');
  createRoot(document.getElementById('root')).render(
    React.createElement(Tldraw, {
      licenseKey: config.licenseKey ?? undefined,
      // tldraw's fonts, icons, translations and embed icons, served by Timmy beside this bundle.
      assetUrls: getAssetUrls({ baseUrl: new URL('assets/', import.meta.url).href }),
      // The canvas survives a reload (kept in this browser's storage for 127.0.0.1).
      persistenceKey: 'timmy-canvas',
      onMount: (editor) => {
        editor.user.updateUserPreferences({ colorScheme: 'dark' });
        // Timmy's agent bridge (F-4, slice 2) drives the canvas through this handle.
        window.timmyCanvas = { editor, tldrawVersion: BUILT_WITH, licenseState: 'pending' };
        showLicense(editor, BUILT_WITH);
        connectBridge(editor, BUILT_WITH);
      },
    }),
  );
}

start().catch((error) => {
  say(`The canvas could not start: ${error instanceof Error ? error.message : String(error)}`, 'error');
});
