// R12: the Card Lab composition around the board — the top strip (the mark, the project, the numbered step path 01 · 02 · 03,
// Sources & models, the theme switch), the summary band (three labelled cells and one quiet action) and the step column (the
// page's kicker, what it is for and what to do on it). Every cell reads the companion's answers through the store.
import { PAGES, activityOf, goTo, newConversation, setTheme, stop, useApp } from './store.js';
import { Button, StateWord, clock } from './ui.jsx';

export function TopStrip({ onFit, onReset, board }) {
  const page = useApp((s) => s.page);
  const theme = useApp((s) => s.theme);
  const config = useApp((s) => s.config);
  const project = config && config.project ? config.project.name : null;
  return (
    <header className="ta-top" role="banner">
      <div className="ta-brand">
        <span className="ta-mark" aria-hidden="true">T</span>
        <strong className="ta-name">TIMMY</strong>
        {project ? <><span className="ta-sep" aria-hidden="true">/</span><span className="ta-project" title={config.project.root}>{project}</span></> : null}
      </div>
      <nav className="ta-steps" aria-label="Steps">
        <ol>
          {PAGES.map((p) => (
            <li key={p.id}>
              <button type="button" className="ta-step" aria-current={page === p.id ? 'step' : undefined} onClick={() => goTo(p.id)}>
                <span className="ta-step-n">{p.n}</span><span className="ta-step-t">{p.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="ta-top-tools">
        {board ? <Button onClick={onFit} title="Show this page's cards">Fit</Button> : null}
        {board ? <Button onClick={onReset} title="Put this page's cards back where Timmy puts them">Reset layout</Button> : null}
        <Button onClick={() => goTo('connect')} className="ta-sources">Sources &amp; models</Button>
        <div className="ta-theme" role="group" aria-label="Theme">
          {['amber', 'glacier'].map((t) => <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>{t === 'amber' ? 'Amber' : 'Glacier'}</button>)}
        </div>
      </div>
    </header>
  );
}

export function SummaryBand() {
  const view = useApp((s) => s.view);
  const turn = useApp((s) => s.turn);
  const viewError = useApp((s) => s.viewError);
  const choice = view && view.choice;
  const ready = view && view.route && view.route.ready;
  const turns = view && view.conversation && Array.isArray(view.conversation.turns) ? view.conversation.turns : [];
  const last = [...turns].reverse().find((t) => t.kind === 'timmy' && t.receipt);
  const running = turn && ['running', 'stopping'].includes(turn.phase);
  const where = view && view.route ? (view.route.kind === 'local' ? (view.route.cloud ? 'Ollama cloud' : 'this computer') : view.route.kind === 'openrouter' ? 'OpenRouter' : 'no route') : '';
  return (
    <section className="ta-band" aria-label="Summary">
      <div className="ta-cell">
        <p className="ta-cell-k">MODEL</p>
        <p className="ta-cell-v">{!view ? (viewError || 'Reading…') : choice && choice.chosen ? <>{choice.model} <span className="ta-muted">· {where}</span></> : <span className="ta-muted">none chosen · Send is off</span>}</p>
      </div>
      <div className="ta-cell">
        <p className="ta-cell-k">AGENT</p>
        <p className="ta-cell-v"><StateWord word={activityOf(turn)} /> {turn && turn.tools && turn.tools.length ? <span className="ta-muted">· {turn.tools.length} tool event{turn.tools.length === 1 ? '' : 's'}</span> : null}{turn && turn.startedAt ? <span className="ta-muted"> · since {clock(turn.startedAt)}</span> : null}</p>
      </div>
      <div className="ta-cell">
        <p className="ta-cell-k">PROOF</p>
        <p className="ta-cell-v">{last ? <><span className={last.receipt.verified ? 'ta-verified' : 'ta-unverified'}>{last.receipt.verified ? '✓ verified' : '✕ not verified'}</span> <code>{last.receipt.id}</code> <span className="ta-muted">· {clock(last.at)}</span></> : <span className="ta-muted">no sealed answer yet</span>}</p>
      </div>
      <div className="ta-band-act">
        {running ? <Button onClick={stop} disabled={turn.phase === 'stopping'}>{turn.phase === 'stopping' ? 'Stopping…' : 'Stop the turn'}</Button>
          : !ready ? <Button onClick={() => goTo('connect')}>Choose a model</Button>
            : <Button onClick={newConversation}>New conversation</Button>}
      </div>
    </section>
  );
}

export function StepColumn() {
  const page = useApp((s) => s.page);
  const note = useApp((s) => s.note);
  const i = PAGES.findIndex((p) => p.id === page);
  const p = PAGES[i] || PAGES[0];
  const next = PAGES[i + 1];
  return (
    <aside className="ta-column" aria-label={`Step ${p.n}`}>
      <p className="ta-kicker">{p.kicker}</p>
      <h1 className="ta-column-title">{p.title}</h1>
      <p className="ta-lead">{p.lead}</p>
      <ol className="ta-checklist">{p.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      {next ? <button type="button" className="ta-next" onClick={() => goTo(next.id)}>Next · {next.n} {next.title} →</button> : null}
      <div className="ta-board-help">
        <p className="ta-kicker">THE BOARD</p>
        <p>Drag a card by its head; resize it from a corner. Draw, write and add notes beside the cards with the tools at the bottom. Your layout stays in this browser.</p>
      </div>
      {note ? <p className="ta-note" role="status">{note}</p> : null}
    </aside>
  );
}
