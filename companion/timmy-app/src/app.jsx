// R12 (the operator's order of 2026-10-25, 03:04 PT): the Timmy app — Timmy's main UI on a tldraw board with the Rive faces.
// Served by the browser companion at /app (src/companion/timmy-app.ts), opened by `timmy app` with the companion's token, and
// bundled on this machine by scripts/canvas/build-app.mjs. It reads and acts only through the companion's own routes (./store.js).
import { createRoot } from 'react-dom/client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { OPEN_FROM_TIMMY, TOKEN, call, onRefused, refusal } from './api.js';
import { Board, fitPage, resetLayout } from './board.jsx';
import { cardsOf } from './cards.jsx';
import { StepColumn, SummaryBand, TopStrip } from './shell.jsx';
import { getState, loadConfig, loadModels, refreshView, setTheme, useApp } from './store.js';
import './app.css';

// the Rive bindings read the page's requests through TimmyShell.fetch (the launch token rides; rive-bindings.js listing())
window.TimmyShell = { fetch: (path, init) => call(path, init) };

const NARROW = '(max-width: 760px)';
const subscribeNarrow = (fn) => { const m = matchMedia(NARROW); m.addEventListener('change', fn); return () => m.removeEventListener('change', fn); };
const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => matchMedia(NARROW).matches);

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

function Column() {
  const page = useApp((s) => s.page);
  const theme = useApp((s) => s.theme);
  return (
    <div className="ta-stack">
      {cardsOf(page).map(({ id, C }) => <div key={id} className="ta-stack-card"><C theme={theme} /></div>)}
    </div>
  );
}

function App() {
  const config = useApp((s) => s.config);
  const narrow = useNarrow();
  const [refused, setRefused] = useState(refusal());
  const [editor, setEditor] = useState(null);
  useEffect(() => onRefused(setRefused), []);
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    (async () => {
      const c = await loadConfig();
      if (stopped || !c.ok) return;
      await refreshView();
      if (getState().localPermission === 'granted') { loadModels('ollama-local'); loadModels('ollama-cloud'); }
      // the view again every few seconds while the page is shown and no turn of this page runs (the turn reads it when it ends)
      const tick = () => {
        timer = setTimeout(async () => {
          const t = getState().turn;
          if (document.visibilityState === 'visible' && !(t && ['running', 'stopping'].includes(t.phase))) await refreshView();
          if (!stopped) tick();
        }, 6000);
      };
      tick();
    })();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  if (refused) return <Refused words={refused} />;
  return (
    <div className={`ta-app${narrow ? ' is-narrow' : ''}`}>
      <TopStrip board={!narrow} onFit={() => editor && fitPage(editor, getState().page)} onReset={() => editor && resetLayout(editor, getState().page)} />
      <SummaryBand />
      <div className="ta-main">
        <StepColumn />
        <main className="ta-stage" aria-label="Timmy's board">
          {narrow ? <Column /> : config && config.ok ? <Board licenseKey={config.licenseKey} onEditor={setEditor} /> : <p className="ta-empty ta-pad">{config ? config.error || 'The companion did not answer.' : 'Opening the board…'}</p>}
        </main>
      </div>
    </div>
  );
}

setTheme(getState().theme);
const root = createRoot(document.getElementById('app'));
root.render(TOKEN ? <App /> : <Refused words={`This page has no token, so it reads nothing. ${OPEN_FROM_TIMMY}`} />);
