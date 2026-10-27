// R12: the Timmy app's state — what the companion answered and what this page is doing — in one small store the cards read
// (useApp) and change only through the actions below. Every fact shown comes from a companion answer named here; nothing is
// made up on the page. A card that has no answer yet says so.
import { useSyncExternalStore } from 'react';
import { call, getJson, postJson, postSse } from './api.js';
import { riveFeed } from './rive.jsx';
import { PAGES, isPage } from './nav.js';

/** Timmy's pages (./nav.js): the permanent rail's order and each page's purpose. */
export { PAGES };

const LOCAL_PERMISSION = 'timmy-app:local-models';
const THEME = 'timmy-app:theme';
const PAGE = 'timmy-app:page';
const DOCK = 'timmy-app:dock';
const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* the choice holds for this visit */ } };

const initial = {
  config: null, // GET /api/app/config
  view: null, // GET /api/chat/view
  viewAt: null,
  viewError: '',
  // (a link may name the page: /app?page=canvas#t=…, as Timmy opens a page directly; else the page this browser was on)
  page: (() => { try { const q = new URLSearchParams(location.search).get('page'); if (isPage(q)) return q; } catch { /* no address */ } return isPage(read(PAGE, '')) ? read(PAGE, '') : 'chat'; })(),
  /** the rail on a phone (a drawer) and the records dock (folded by default) */
  drawer: false,
  // the rail folded to its icons, per page the person chose it on (null: folded on the Canvas only, the default)
  railFold: null,
  dock: read(DOCK, '') === 'open',
  projects: null, // GET /api/projects (accounts) — null until asked
  projectId: null,
  license: null, // the canvas SDK's own licence readout (pages/canvas.jsx, license-state.js), once the Canvas opened
  canvasIo: null, // { export(), import() } while the Canvas is open
  theme: read(THEME, 'amber') === 'glacier' ? 'glacier' : 'amber',
  /** 'unasked' | 'granted' | 'declined': whether this page may ask the Ollama on this computer for its list of models */
  localPermission: ['granted', 'declined'].includes(read(LOCAL_PERMISSION, '')) ? read(LOCAL_PERMISSION, '') : 'unasked',
  check: {}, // provider id → POST /api/connections/<id>/check's state
  models: {}, // source → GET /api/chat/models answer
  modelsAsking: {},
  search: { openrouter: '' },
  choosing: null, // { source, model }
  chooseResult: null, // POST /api/chat/choose's answer
  turn: null, // the turn this page runs (see send)
  pull: null, // an Ollama download this page started
  note: '',
};

let state = initial;
const subs = new Set();
const set = (patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; for (const fn of subs) fn(); };
export const getState = () => state;
const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
/** The app's state, or one slice of it: `useApp((s) => s.view)`. */
export function useApp(select = (s) => s) { return useSyncExternalStore(subscribe, () => select(state)); }

// ── reads ──

/** The project this page asked for by id (the rail's switcher), or null for the one the companion follows. */
export const projectQuery = (join = '?') => (state.projectId ? `${join}project=${encodeURIComponent(state.projectId)}` : '');

/** Which project's reads are current: bumped by a switch, so an answer read for the project before is dropped, never shown. */
let generation = 0;

export async function loadConfig() {
  const g = generation;
  const c = await getJson(`/api/app/config${projectQuery()}`);
  if (g === generation) set({ config: c });
  return c;
}

/** The Chat's view of the project (route, choice, providers, the saved conversation); the local Ollama only with permission. */
export async function refreshView(o = {}) {
  const skip = state.localPermission !== 'granted';
  const q = [skip ? 'local=skip' : o.fresh ? 'fresh=1' : '', projectQuery('').trim()].filter(Boolean).join('&');
  const g = generation;
  const v = await getJson(`/api/chat/view${q ? `?${q}` : ''}`);
  if (g !== generation) return v;
  if (v.ok) set({ view: v, viewAt: new Date().toISOString(), viewError: '' });
  else set({ viewError: v.error || 'The companion did not answer the Chat’s view.' });
  return v;
}

/** One source's models (openrouter, ollama-local, ollama-cloud), searched. */
export async function loadModels(source, o = {}) {
  if (source === 'ollama-local' && state.localPermission !== 'granted') return null;
  set((s) => ({ modelsAsking: { ...s.modelsAsking, [source]: true } }));
  const q = new URLSearchParams({ source });
  const search = o.search ?? state.search[source] ?? '';
  if (search) q.set('search', search);
  if (o.fresh) q.set('fresh', '1');
  if (source === 'openrouter') q.set('sort', o.sort || 'recent');
  if (state.projectId) q.set('project', state.projectId);
  const g = generation;
  const m = await getJson(`/api/chat/models?${q}`);
  if (g !== generation) return m;
  set((s) => ({ models: { ...s.models, [source]: { ...m, at: new Date().toISOString() } }, modelsAsking: { ...s.modelsAsking, [source]: false } }));
  return m;
}

export function setSearch(source, text) { set((s) => ({ search: { ...s.search, [source]: text } })); }

// ── the person's choices ──

// `from`: the page the person came from (a framed app's "Back" returns there)
export function goTo(page) { if (isPage(page)) { set((s) => ({ page, drawer: false, from: s.page !== page ? s.page : s.from })); write(PAGE, page); try { window.scrollTo(0, 0); } catch { /* no window */ } } }
/** The page the person came from, else Chat (Timmy's home). */
export function goBack() { const s = getState(); goTo(s.from && s.from !== s.page && isPage(s.from) ? s.from : 'chat'); }
/** Open a mini-app at a place of its own (Files' "Open inspection": Card Lab at `/?run=<id>`): its page opens it there. */
export function openApp(app, to) { set({ appTarget: { app, to: typeof to === 'string' ? to : null, at: Date.now() } }); goTo(app); }
export function takeAppTarget(app) { const t = state.appTarget; if (!t || t.app !== app) return null; set({ appTarget: null }); return t.to; }
export function setDrawer(open) { set({ drawer: !!open }); }
export function setRailSlim(slim) { set((s) => ({ railFold: { ...(s.railFold || {}), [s.page]: !!slim } })); }
export function setDock(open) { set({ dock: !!open }); write(DOCK, open ? 'open' : 'folded'); }

/** The person's projects (GET /api/projects: only a companion with accounts answers it; else the one project the page shows). */
export async function switchProject(id) {
  if (state.turn && ['running', 'stopping'].includes(state.turn.phase)) { set({ note: 'A turn is running: stop it before switching projects.' }); return; }
  generation += 1;
  set({ projectId: id || null, turn: null, view: null, viewError: '', chooseResult: null, note: '', models: {}, pull: null });
  await loadConfig();
  await refreshView();
}

export async function loadProjects() {
  const r = await getJson('/api/projects');
  set({ projects: r });
  return r;
}
export function setTheme(theme) {
  const t = theme === 'glacier' ? 'glacier' : 'amber';
  set({ theme: t });
  write(THEME, t);
  try { document.documentElement.dataset.theme = t; } catch { /* no document */ }
}

/** The person's answer to "may Timmy look for models on this computer?" (asked on the page, never assumed). */
export async function answerLocalPermission(granted) {
  const v = granted ? 'granted' : 'declined';
  set({ localPermission: v });
  write(LOCAL_PERMISSION, v);
  if (!granted) { set({ note: 'Timmy will not look for models on this computer. You can change this on the Models card.' }); return; }
  await checkProvider('ollama-local');
  await Promise.all([loadModels('ollama-local', { fresh: true }), loadModels('ollama-cloud'), refreshView({ fresh: true })]);
}

/** POST /api/connections/<id>/check — the provider's own check (no model runs). */
export async function checkProvider(id) {
  set((s) => ({ check: { ...s.check, [id]: { state: 'checking', words: 'Checking…' } } }));
  const r = await postJson(`/api/connections/${id}/check`, {});
  const st = r && r.state && typeof r.state === 'object' ? r.state : { state: 'failed', words: r.error || 'The check did not answer.' };
  set((s) => ({ check: { ...s.check, [id]: { ...st, at: new Date().toISOString() } } }));
  // the provider's Rive faces (the Models card's, the Canvas desk's) move with this page's own check
  if (r && r.state && typeof r.state.state === 'string') riveFeed.provider(id, r.state.state, `POST /api/connections/${id}/check`);
  return st;
}

/** POST /api/chat/choose — the model the next turn uses (the setup's own write path). */
export async function choose(source, model) {
  set({ choosing: { source, model }, chooseResult: null });
  const r = await postJson(`/api/chat/choose${projectQuery()}`, { source, model });
  set({ choosing: null, chooseResult: { ...r, source, model, at: new Date().toISOString() } });
  await refreshView();
  return r;
}

// ── an Ollama download (the companion's own flow: size first, then the person's confirmation, then progress) ──

export async function startPull(model) {
  set({ pull: { model, phase: 'asking', words: `Asking how big ${model} is…` } });
  try {
    await postSse('/api/connections/ollama-local/pull', { model }, (name, data) => {
      if (name === 'size') set((s) => ({ pull: { ...s.pull, id: data.id, phase: 'size', size: data.size, words: data.words } }));
      else if (name === 'waiting') set((s) => ({ pull: { ...s.pull, phase: 'waiting', waiting: data.words } }));
      else if (name === 'confirmed') set((s) => ({ pull: { ...s.pull, phase: 'downloading', words: data.words } }));
      else if (name === 'progress') set((s) => ({ pull: { ...s.pull, phase: 'downloading', done: data.done, total: data.total, words: data.words } }));
      else if (name === 'done' || name === 'cancelled' || name === 'error') set((s) => ({ pull: { ...s.pull, phase: name, words: data.words } }));
    });
  } catch (e) { set((s) => ({ pull: { ...s.pull, phase: 'error', words: e instanceof Error ? e.message : String(e) } })); }
  if (state.pull && state.pull.phase === 'done') await Promise.all([loadModels('ollama-local', { fresh: true }), refreshView({ fresh: true })]);
}
/** A download's confirmation and cancel: what the companion answered is said, a refusal included (never shown as done). */
const pullAnswer = (r, what) => { if (!r.ok) set((s) => ({ pull: s.pull ? { ...s.pull, words: `${what} was not taken: ${r.error || r.words || `the companion answered ${r.status}`}.` } : s.pull })); };
export async function confirmPull() { const p = state.pull; if (p && p.id) pullAnswer(await postJson('/api/connections/ollama-local/pull/confirm', { id: p.id }), 'The confirmation'); }
export async function cancelPull() {
  const p = state.pull;
  if (p && p.id) pullAnswer(await postJson('/api/connections/ollama-local/pull/cancel', { id: p.id }), 'Cancel');
  set((s) => ({ pull: s.pull && ['done', 'error', 'cancelled'].includes(s.pull.phase) ? null : s.pull }));
}
export function clearPull() { set({ pull: null }); }

// ── the chat turn (contract C3: POST /api/chat/turn answers route, turn, delta, tool, needs-you, done | error) ──

const projectRoot = () => state.config && state.config.project ? state.config.project.root : null;
const keyOf = () => `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The activity word the AgentConsole face shows (its vocabulary: idle · working · awaiting · stopping · stopped · failed). */
export function activityOf(turn) {
  if (!turn) return 'idle';
  if (turn.phase === 'stopping') return 'stopping';
  if (turn.needsYou) return 'awaiting';
  if (turn.phase === 'running') return 'working';
  if (turn.phase === 'failed' || turn.phase === 'refused') return 'failed';
  if (turn.phase === 'stopped') return 'stopped';
  return 'idle';
}

export async function send(message) {
  const text = String(message || '').trim();
  const root = projectRoot();
  if (!text || (state.turn && ['running', 'stopping'].includes(state.turn.phase))) return;
  if (!root) { set({ turn: { phase: 'failed', message: text, text: '', tools: [], error: 'Not sent: the companion named no project for this page.' } }); return; }
  const controller = new AbortController();
  set({ turn: { phase: 'running', message: text, text: '', tools: [], startedAt: new Date().toISOString(), controller } });
  const patch = (fn) => set((s) => ({ turn: s.turn ? { ...s.turn, ...fn(s.turn) } : s.turn }));
  try {
    await postSse(`/api/chat/turn${projectQuery()}`, { message: text, key: keyOf(), project: { root } }, (name, d) => {
      // the AgentConsole faces move with the turn's own events (rive-bindings.js fromSse), never on their own
      riveFeed.sse(name, d);
      if (name === 'route') patch(() => ({ route: d }));
      else if (name === 'turn') {
        patch(() => ({ id: d.id, startedAt: d.startedAt }));
        // Stop was pressed before the turn had its id: it is asked now
        if (state.turn && state.turn.stopWanted) sendStop();
      }
      else if (name === 'delta') patch((t) => ({ text: d.reset ? String(d.text || '') : t.text + String(d.text || '') }));
      else if (name === 'tool') patch((t) => ({ tools: [...t.tools.filter((x) => x.call !== d.call), d] }));
      else if (name === 'needs-you') patch(() => ({ needsYou: d }));
      // (the turn's status, sealTurn's: answered · refused (nothing was sent) · failed · cancelled (Stop))
      else if (name === 'done') patch(() => ({ phase: ({ answered: 'done', cancelled: 'stopped', failed: 'failed', refused: 'refused' })[d.status] || 'done', done: d, needsYou: null, endedAt: new Date().toISOString() }));
      else if (name === 'error') patch(() => ({ phase: 'failed', error: d.words || (d.lines || []).join('\n'), lines: d.lines || [], needsYou: null }));
    }, controller.signal);
  } catch (e) {
    if (!(e && e.name === 'AbortError')) patch(() => ({ phase: 'failed', error: e instanceof Error ? e.message : String(e) }));
  }
  // a stream that ended with no status: said so (a stop that was asked is not a stop observed)
  patch((t) => (['running', 'stopping'].includes(t.phase) ? { phase: 'failed', error: t.phase === 'stopping' ? 'The stream ended after Stop was asked, before the turn said how it ended; Runs & receipts has its receipt when one was sealed.' : 'The stream ended before the turn said it was done.' } : {}));
  await refreshView();
}

/** Stop: asked of the companion by the turn's id (the project this page shows); "stopping" only once the companion took it. */
export async function stop() {
  const t = state.turn;
  if (!t || t.phase !== 'running') return;
  if (!t.id) { set({ turn: { ...t, stopWanted: true, stopWords: 'Stop is asked as soon as the companion names this turn…' } }); return; }
  await sendStop();
}
async function sendStop() {
  const t = state.turn;
  if (!t || !t.id || t.stopAsked) return;
  set({ turn: { ...t, stopAsked: true, stopWanted: false, stopWords: 'Asking the companion to stop the turn…' } });
  const r = await postJson(`/api/chat/stop${projectQuery()}`, { id: t.id });
  const now = state.turn;
  if (!now || now.id !== t.id || now.phase !== 'running') return;
  if (r.ok) { set({ turn: { ...now, phase: 'stopping', stopWords: r.words || 'Stop asked.' } }); riveFeed.stopping('Stop taken by the companion (POST /api/chat/stop)'); }
  else set({ turn: { ...now, stopAsked: false, stopWords: `Not stopped: ${r.error || r.words || `the companion answered ${r.status}`}. Press Stop again.` } });
}

export async function answerNeedsYou(choice) {
  const t = state.turn;
  if (!t || !t.needsYou) return;
  const ask = t.needsYou;
  set({ turn: { ...t, needsYou: null, answered: [...(t.answered || []), { tool: ask.tool, choice }] } });
  const r = await postJson(`/api/chat/answer${projectQuery()}`, { id: ask.id, choice });
  // a refused answer (the ask timed out and was denied, or the turn ended) is said, and the ask shown again while the turn runs
  if (!r.ok) set((s) => ({ turn: s.turn ? { ...s.turn, needsYou: s.turn.phase === 'running' ? ask : null, error: `Your answer was not taken: ${r.error || r.words || `the companion answered ${r.status}`}.` } : s.turn }));
}

export async function newConversation() {
  const root = projectRoot();
  if (!root || (state.turn && ['running', 'stopping'].includes(state.turn.phase))) return;
  const r = await postJson(`/api/chat/new${projectQuery()}`, { project: { root } });
  set({ turn: null, note: r.ok ? 'A new conversation started; the last one stays saved.' : r.error || r.words || 'A new conversation did not start.' });
  await refreshView();
}

export function say(note) { set({ note }); }
/** The current project generation (a page keyed by it starts again after a switch). */
export const projectGeneration = () => generation;
export function setLicense(license) { set({ license }); }
export function setCanvasIo(canvasIo) { set({ canvasIo }); }
export { call };
