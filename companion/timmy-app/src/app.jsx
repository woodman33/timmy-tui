// R12 (the operator's order of 2026-10-25, 03:04 PT, and the finish brief): the Timmy app — Timmy's main UI in one shell (the
// permanent left rail, the top bar, the page, the records dock and the status footer: ./shell.jsx), its pages (./pages/*), the
// Canvas a licensed tldraw desk with Timmy's native Rive components. Served by the browser companion at /app
// (src/companion/timmy-app.ts), opened by `timmy app` with the companion's token, bundled on this machine by
// scripts/canvas/build-app.mjs. It reads and acts only through the companion's own routes (./store.js).
import { createRoot } from 'react-dom/client';
import { Suspense, lazy, useEffect, useState } from 'react';
import { OPEN_FROM_TIMMY, TOKEN, call, onRefused, refusal } from './api.js';
import { pageOf } from './nav.js';
import { Dock, Footer, Rail, Topbar, useRailSlim } from './shell.jsx';
import { getState, loadConfig, loadModels, refreshView, setDrawer, setTheme, useApp } from './store.js';
import ChatPage from './pages/chat.jsx';
import ModelsPage from './pages/models.jsx';
import CanvasPage from './pages/canvas.jsx';
import { PAGE_PARTS } from './pages/index.js';
import './app.css';

// the Rive bindings read the page's requests through TimmyShell.fetch (the launch token rides; rive-bindings.js listing())
window.TimmyShell = { fetch: (path, init) => call(path, init) };

const DRAWN = { chat: ChatPage, models: ModelsPage, canvas: CanvasPage, ...PAGE_PARTS };

function Refused({ words }) {
  return (
    <main className="ta-refused">
      <span className="ta-mark" aria-hidden="true">T</span>
      <h1>Timmy</h1>
      <p>{words}</p>
      <p className="ta-muted"><code>timmy app</code></p>
    </main>
  );
}

function App() {
  const page = useApp((s) => s.page);
  const drawer = useApp((s) => s.drawer);
  const projectId = useApp((s) => s.projectId);
  const slim = useRailSlim();
  const [refused, setRefused] = useState(refusal());
  useEffect(() => onRefused(setRefused), []);
  useEffect(() => { document.title = `${pageOf(page).title} · Timmy`; }, [page]);
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    (async () => {
      // the companion may still be starting: its config is asked again (1 s, 2 s, 4 s … at most 15 s) until it answers
      let c = await loadConfig();
      for (let wait = 1000; !stopped && !refusal() && !c.ok; wait = Math.min(15000, wait * 2)) {
        await new Promise((r) => { timer = setTimeout(r, wait); });
        if (!stopped && !refusal()) c = await loadConfig();
      }
      if (stopped || !c.ok) return;
      await refreshView();
      if (getState().localPermission === 'granted') { loadModels('ollama-local'); loadModels('ollama-cloud'); }
      // the view again every few seconds while the page is shown and no turn of this page runs (the turn reads it when it ends)
      const tick = () => {
        timer = setTimeout(async () => {
          const t = getState().turn;
          if (document.visibilityState === 'visible' && !(t && ['running', 'stopping'].includes(t.phase))) await refreshView();
          if (!stopped && !refusal()) tick();
        }, 6000);
      };
      tick();
    })();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  if (refused) return <Refused words={refused} />;
  const Current = DRAWN[page] || ChatPage;
  return (
    <div className={`ta-app${drawer ? ' has-drawer' : ''}${slim ? ' is-slim' : ''}`} data-page-now={page}>
      <Rail />
      {drawer ? <button type="button" className="ta-scrim" aria-label="Close the menu" onClick={() => setDrawer(false)} /> : null}
      <div className="ta-main">
        <Topbar />
        <main className="ta-pagewrap" id="ta-page">
          <Suspense fallback={<p className="ta-pad ta-muted">Opening…</p>}><Current key={`${page}:${projectId || 'followed'}`} /></Suspense>
        </main>
        <Dock />
        <Footer />
      </div>
    </div>
  );
}

setTheme(getState().theme);
const root = createRoot(document.getElementById('app'));
root.render(TOKEN ? <App /> : <Refused words={`This page has no token, so it reads nothing. ${OPEN_FROM_TIMMY}`} />);
export { lazy };
