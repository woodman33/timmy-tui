// R11 round 6 (H174): tldraw's ACTUAL license state, read the SDK's own way and said in words — never inferred from a key being
// present, never read from the key (this module never sees it: canvas.js hands the `licenseKey` prop to <Tldraw/> and nothing
// else), and nothing here hides the SDK's notice or watermark.
//
// THE API (tldraw 5.5.2, @tldraw/editor, read in node_modules): <TldrawEditor/> makes a LicenseManager from the `licenseKey`
// prop (src/lib/license/LicenseProvider.tsx) and assigns it to the editor as `editor.licenseManager` (Editor.ts: "the license
// manager whose feature flags apply to this editor … so that UI rendered outside the editor tree can resolve the editor's
// license through the editor instance"); its verdict is the atom `licenseManager.state` (LicenseManager.ts: LicenseState =
// 'pending' | 'licensed' | 'licensed-with-watermark' | 'unlicensed' | 'unlicensed-production' | 'expired'), set once the key is
// validated against tldraw's public key; the React route is `useMaybeLicenseManager()` + `useValue` (exported by tldraw). The
// SDK writes its own messages to the console (outputMessages) and draws its watermark where its state says so.
//
// It imports nothing: canvas.js hands in tldraw's `react` (an effect over the SDK's atoms), so the rules below run in Node's
// tests too.

/** The SDK's states, in its own words (the meaning beside each state in LicenseManager.ts), as the Studio says them. */
export const LICENSE_WORDS = Object.freeze({
  pending: 'pending: the SDK is checking its license',
  licensed: 'licensed (the SDK found a valid, active license)',
  'licensed-with-watermark': 'licensed with watermark (an evaluation or with-watermark license: the SDK shows its watermark)',
  unlicensed: 'unlicensed: no valid license found or the key is invalid — a development address (localhost / 127.0.0.1), so every feature is on and no watermark is shown',
  'unlicensed-production': 'unlicensed in production: no valid license for this address (missing, invalid or wrong domain) — the SDK shows its watermark',
  expired: 'expired: the SDK found a license past its term (30 days for a regular license, at once for an evaluation one)',
  unknown: 'not checked: this editor has no license manager (made without <TldrawEditor/>)',
});

/** Whether the SDK draws its watermark in this state (its Watermark.tsx reads the same states). */
export const WATERMARK_STATES = Object.freeze(['licensed-with-watermark', 'unlicensed-production']);

/** The readout of one editor, now: { state, words, watermark, development }. */
export function licenseReadout(editor) {
  const m = editor && editor.licenseManager ? editor.licenseManager : null;
  let state = 'unknown';
  try { state = m && m.state && typeof m.state.get === 'function' ? String(m.state.get()) : 'unknown'; } catch (e) { state = 'unknown'; }
  const words = LICENSE_WORDS[state] || `${state}: a state this build does not name`;
  return { state, words, watermark: WATERMARK_STATES.includes(state), development: Boolean(m && m.isDevelopment), checked: state !== 'pending' && state !== 'unknown' };
}

/**
 * `react`: tldraw's effect over its atoms (import { react } from 'tldraw'). `watch(editor, fn)` calls fn(readout) now and on
 * every change of the SDK's state atom; returns the stop function. `readout(editor)` reads once.
 */
export function createLicenseReadout({ react }) {
  const watchers = [];
  function watch(editor, fn) {
    if (!editor || typeof fn !== 'function') return () => {};
    let last = '';
    const tell = () => { const r = licenseReadout(editor); if (r.state !== last) { last = r.state; fn(r); } };
    if (typeof react !== 'function' || !editor.licenseManager || !editor.licenseManager.state) { tell(); return () => {}; }
    const stop = react('timmy canvas: the license state', () => { editor.licenseManager.state.get(); tell(); });
    watchers.push(stop);
    return () => { try { stop(); } catch (e) { /* stopped */ } const i = watchers.indexOf(stop); if (i >= 0) watchers.splice(i, 1); };
  }
  return { readout: licenseReadout, watch, words: LICENSE_WORDS, stopAll: () => { for (const s of watchers.splice(0)) { try { s(); } catch (e) { /* stopped */ } } } };
}
