// R12: the Timmy app's cards — each one a part of Timmy's work, drawn from the companion's own answers (named on each card) and
// acting through the companion's own routes. The same cards are the board's shapes (./board.jsx) and, on a narrow screen, a
// column (./app.jsx). Nothing a card says is made up on the page: what was not asked yet says so.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionFace, ConsoleFace, ProviderFace } from './rive.jsx';
import {
  PAGES, activityOf, answerLocalPermission, answerNeedsYou, cancelPull, checkProvider, choose, clearPull, confirmPull, goTo, loadModels,
  newConversation, send, setSearch, startPull, stop, useApp,
} from './store.js';
import { Button, Card, Empty, Facts, Out, StateWord, clock, day } from './ui.jsx';
import { Markdown } from './md.jsx';

/** Brings a card into view: the board's camera on it, or (a column) the page scrolled to it. */
export function showCard(id) {
  const app = typeof window !== 'undefined' ? window.timmyApp : null;
  if (app && typeof app.show === 'function') { app.show(id); return; }
  const el = typeof document !== 'undefined' ? document.querySelector(`.ta-card[data-card="${id}"]`) : null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const PROVIDER_NAMES = { openrouter: 'OpenRouter', 'ollama-local': 'Ollama · this computer', 'ollama-cloud': 'Ollama · cloud', cloudflare: 'Cloudflare' };
const providerName = (id) => PROVIDER_NAMES[id] || id;
const providerOf = (view, id) => (view && Array.isArray(view.providers) ? view.providers.find((p) => p.id === id) : null);
const chosenOf = (view) => (view && view.choice && view.choice.chosen ? { source: view.choice.source, model: view.choice.model } : null);
const sizeOf = (row) => (row && typeof row.size === 'number' ? (row.size >= 1e9 ? `${(row.size / 1e9).toFixed(1)} GB` : `${Math.round(row.size / 1e6)} MB`) : null);
const priceOf = (row) => {
  const p = row && row.price;
  if (!p) return null;
  if (p.free === true) return 'free';
  if (p.free === 'unknown') return 'price unknown';
  const f = (n) => (typeof n === 'number' ? `$${n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 2 : 0)}` : '?');
  return `${f(p.inPerM)} in · ${f(p.outPerM)} out /M${p.varies ? ' (varies)' : ''}`;
};
const capsOf = (row) => {
  const c = (row && row.caps) || {};
  return ['tools', 'vision', 'reasoning'].filter((k) => c[k] === true);
};

// ── 01 · CONNECT ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function ModelRow({ row, source, chosen, onUse, busy }) {
  const inUse = chosen && chosen.model === row.id;
  const caps = capsOf(row);
  return (
    <li className={`ta-model${inUse ? ' is-chosen' : ''}`} data-model={row.id}>
      <div className="ta-model-main">
        <span className="ta-model-id">{row.id}</span>
        <span className="ta-model-meta">
          {row.maker && row.maker !== 'unknown' ? <span>{row.maker}</span> : null}
          {sizeOf(row) ? <span>{sizeOf(row)}</span> : null}
          {row.contextLength ? <span>{Math.round(row.contextLength / 1000)}k context</span> : null}
          {source === 'openrouter' && priceOf(row) ? <span>{priceOf(row)}</span> : null}
          {caps.map((c) => <span key={c} className="ta-cap">{c}</span>)}
          {row.loaded ? <span className="ta-cap">loaded</span> : null}
        </span>
      </div>
      {inUse ? <span className="ta-in-use" aria-label={`${row.id} is the chat's model`}>in use</span>
        : onUse ? <Button kind="quiet" disabled={busy} onClick={() => onUse(row)} aria-label={`Use ${row.id} for the chat`}>Use for chat</Button>
          : <span className="ta-muted">on Ollama’s servers</span>}
    </li>
  );
}

function Pull() {
  const pull = useApp((s) => s.pull);
  if (!pull) return null;
  const pct = pull.total ? Math.round((100 * (pull.done || 0)) / pull.total) : null;
  return (
    <div className="ta-pull" role="status" data-phase={pull.phase}>
      <p className="ta-pull-words">{pull.words}</p>
      {pull.phase === 'downloading' && pct !== null ? <progress max="100" value={pct} aria-label={`Download of ${pull.model}`}>{pct}%</progress> : null}
      <div className="ta-row">
        {pull.phase === 'waiting' || pull.phase === 'size' ? <Button kind="primary" onClick={confirmPull}>Download {pull.model}{pull.size ? ` (${pull.size})` : ''}</Button> : null}
        {['asking', 'size', 'waiting', 'downloading'].includes(pull.phase) ? <Button onClick={cancelPull}>Cancel</Button> : <Button onClick={clearPull}>Close</Button>}
      </div>
    </div>
  );
}

export function ModelsHereCard({ theme }) {
  const view = useApp((s) => s.view);
  const permission = useApp((s) => s.localPermission);
  const local = useApp((s) => s.models['ollama-local']);
  const cloud = useApp((s) => s.models['ollama-cloud']);
  const asking = useApp((s) => s.modelsAsking);
  const check = useApp((s) => s.check['ollama-local']);
  const choosing = useApp((s) => s.choosing);
  const chooseResult = useApp((s) => s.chooseResult);
  const config = useApp((s) => s.config);
  const pull = useApp((s) => s.pull);
  const p = providerOf(view, 'ollama-local');
  const chosen = chosenOf(view);
  const state = check && check.state ? check.state : p ? p.state : 'not asked';
  const rows = local && Array.isArray(local.rows) ? local.rows : [];
  const cloudRows = cloud && Array.isArray(cloud.rows) ? cloud.rows : [];
  const starters = config && config.ollama && Array.isArray(config.ollama.starters) ? config.ollama.starters : [];
  const install = config && config.ollama ? config.ollama.install : null;
  const use = (row) => choose('ollama-local', row.id);
  const pc = providerOf(view, 'ollama-cloud');
  const cloudNext = pc && pc.next ? pc.next : '';
  return (
    <Card id="models-here" kicker="01 · MODELS ON THIS COMPUTER" title="Your models, found with your permission"
      face={<ProviderFace provider="ollama-local" name="Ollama on this computer" state={permission === 'granted' ? state : 'not asked'} source={check ? 'POST /api/connections/ollama-local/check' : 'GET /api/chat/view (providers)'} theme={theme} />}
      tools={permission === 'granted' ? <Button onClick={() => Promise.all([checkProvider('ollama-local'), loadModels('ollama-local', { fresh: true }), loadModels('ollama-cloud')])} disabled={asking['ollama-local']}>{asking['ollama-local'] ? 'Looking…' : 'Look again'}</Button> : null}>
      {permission !== 'granted' ? (
        <div className="ta-ask" data-permission={permission}>
          <p className="ta-ask-q"><strong>May Timmy look for the models on this computer?</strong></p>
          <p>Timmy asks the Ollama on this computer for its list of models (its <code>/api/tags</code>, then <code>/api/show</code> for each). No model runs, nothing is downloaded, and nothing leaves this computer. Cloud models your Ollama account adds (names ending in <code>:cloud</code>) are listed too.</p>
          {permission === 'declined' ? <p className="ta-muted">You said not now. Nothing has been asked.</p> : null}
          <div className="ta-row">
            <Button kind="primary" onClick={() => answerLocalPermission(true)}>Yes, look for models</Button>
            {permission === 'unasked' ? <Button onClick={() => answerLocalPermission(false)}>Not now</Button> : null}
          </div>
        </div>
      ) : (
        <>
          <p className="ta-line"><StateWord word={state} live={state === 'checked' || state === 'connected'} /> {check && check.words ? check.words : local && local.words ? local.words : 'Asking…'}</p>
          {rows.length ? (
            <ul className="ta-models" aria-label="Chat models on this computer">
              {rows.map((r) => <ModelRow key={r.id} row={r} source="ollama-local" chosen={chosen && chosen.source === 'ollama-local' ? chosen : null} onUse={use} busy={!!choosing} />)}
            </ul>
          ) : local ? (
            <div className="ta-none">
              <Empty>{local.listed ? `Ollama lists ${local.listed}, none of them a local chat model${local.left ? ` (${local.left})` : ''}.` : 'No chat model is installed here yet.'}</Empty>
              {state === 'not installed' && install ? <p>Install Ollama: {install.install}. Then {install.start}. <Out href={install.link}>Ollama’s download page</Out></p> : null}
              {starters.length && state !== 'not installed' ? (
                <div className="ta-starters">
                  <p className="ta-muted">Download a starter model into Ollama (you see its size and confirm first):</p>
                  {starters.map((s) => (
                    <div key={s.model} className="ta-starter">
                      <span><code>{s.model}</code> · {s.size} · {s.use}</span>
                      <Button disabled={!!pull} onClick={() => startPull(s.model)}>Download…</Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <Pull />
          <h3 className="ta-sub">Cloud models through your Ollama account</h3>
          {cloudRows.length ? (
            <>
              <ul className="ta-models" aria-label="Ollama cloud models">
                {cloudRows.map((r) => <ModelRow key={r.id} row={r} source="ollama-cloud" chosen={chosen} onUse={null} busy={!!choosing} />)}
              </ul>
              <p className="ta-muted">These run on Ollama’s computers under your Ollama account, not on this one. {cloudNext || 'Chat on them is set up with a key from Ollama (see Connections).'}</p>
            </>
          ) : <Empty>{cloud ? cloud.words || cloud.error || 'None listed.' : 'Not asked yet.'}</Empty>}
          {chooseResult && (chooseResult.source === 'ollama-local') ? <p className={`ta-result${chooseResult.ok ? ' is-ok' : ''}`} role="status">{chooseResult.words}</p> : null}
          {chosen && view && view.route && view.route.ready ? <div className="ta-row ta-next-step"><Button kind="primary" onClick={() => goTo('chat')}>Start the chat · 02 →</Button><span className="ta-muted">with {chosen.model}</span></div> : null}
        </>
      )}
    </Card>
  );
}

export function ProvidersCard({ theme }) {
  const view = useApp((s) => s.view);
  const checks = useApp((s) => s.check);
  const [signIn, setSignIn] = useState(null);
  const providers = view && Array.isArray(view.providers) ? view.providers : [];
  const startSignIn = async () => {
    const { postJson } = await import('./api.js');
    const r = await postJson('/api/connections/openrouter/start', { callback: `${location.origin}/api/connections/openrouter/callback` });
    setSignIn(r);
    if (r.ok && r.url) window.open(r.url, '_blank', 'noopener');
  };
  return (
    <Card id="providers" kicker="01 · CONNECTIONS" title="Where models can run"
      tools={<Button onClick={() => showCard('catalog')} title="OpenRouter's catalog, below these cards">OpenRouter’s catalog ↓</Button>}>
      {!providers.length ? <Empty>{view ? 'The companion listed no providers.' : 'Reading the providers…'}</Empty> : (
        <ul className="ta-providers">
          {providers.map((p) => {
            const c = checks[p.id];
            const word = c && c.state ? c.state : p.state;
            return (
              <li key={p.id} className="ta-provider" data-provider={p.id}>
                <ProviderFace provider={p.id} name={providerName(p.id)} state={word} source={c ? `POST /api/connections/${p.id}/check` : 'GET /api/chat/view (providers)'} theme={theme} size="card" />
                <div className="ta-provider-words">
                  <p className="ta-provider-name"><strong>{providerName(p.id)}</strong> <StateWord word={word} live={word === 'checked' || word === 'connected'} /></p>
                  <p>{c && c.words ? c.words : p.words}</p>
                  {p.next ? <p className="ta-muted">{p.next}</p> : null}
                  <div className="ta-row">
                    {p.id === 'openrouter' && p.state === 'not set up' ? <Button kind={view && view.route && view.route.ready ? 'quiet' : 'primary'} onClick={startSignIn}>Sign in with OpenRouter</Button> : null}
                    {p.id === 'openrouter' || p.id === 'ollama-local' ? <Button onClick={() => checkProvider(p.id)}>Check</Button> : null}
                    {(p.links || []).slice(0, 2).map((l) => <Out key={l.url} href={l.url}>{l.label}</Out>)}
                  </div>
                  {p.id === 'openrouter' && signIn ? <p className="ta-muted" role="status">{signIn.words || signIn.error}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function CatalogCard() {
  const view = useApp((s) => s.view);
  const m = useApp((s) => s.models.openrouter);
  const search = useApp((s) => s.search.openrouter);
  const asking = useApp((s) => s.modelsAsking.openrouter);
  const choosing = useApp((s) => s.choosing);
  const chooseResult = useApp((s) => s.chooseResult);
  const chosen = chosenOf(view);
  const timer = useRef(0);
  useEffect(() => { if (!m && !asking) loadModels('openrouter'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onSearch = (e) => {
    setSearch('openrouter', e.target.value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => loadModels('openrouter'), 250);
  };
  const rows = m && Array.isArray(m.rows) ? m.rows : [];
  return (
    <Card id="catalog" kicker="01 · CLOUD MODELS" title="OpenRouter’s catalog"
      tools={<input className="ta-search" type="search" placeholder="Search models" value={search} onChange={onSearch} aria-label="Search OpenRouter's models" />}>
      <p className="ta-muted">{m ? `${m.words || ''}${typeof m.matched === 'number' ? ` · ${m.matched} of ${m.all} match` : ''}` : 'Reading the catalog this computer keeps…'}</p>
      {rows.length ? (
        <ul className="ta-models ta-models-grid" aria-label="OpenRouter models">
          {rows.map((r) => <ModelRow key={r.id} row={r} source="openrouter" chosen={chosen && chosen.source === 'openrouter' ? chosen : null} onUse={(row) => choose('openrouter', row.id)} busy={!!choosing} />)}
        </ul>
      ) : m ? <Empty>No model matches.</Empty> : null}
      {chooseResult && chooseResult.source === 'openrouter' ? <p className={`ta-result${chooseResult.ok ? ' is-ok' : ''}`} role="status">{chooseResult.words}</p> : null}
    </Card>
  );
}

const SURFACES = { repl: 'the REPL', workbench: 'the Workbench', monitor: 'the monitor', companion: 'another page', studio: 'the Studio' };
export const surfaceWord = (s) => SURFACES[s] || String(s || 'another surface');

// ── 02 · CHAT ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Turn({ t }) {
  if (t.kind === 'you') return <li className="ta-turn ta-you"><p className="ta-who">You <span className="ta-when">{clock(t.at)}</span></p><p className="ta-text">{t.text}</p></li>;
  if (t.kind === 'tool') return <li className="ta-turn ta-tool"><p className="ta-who">Tool · {t.tool || 'a tool'}</p><p className="ta-text ta-mono">{String(t.text || '').slice(0, 600)}</p></li>;
  const r = t.receipt;
  return (
    <li className={`ta-turn ta-timmy${t.stopped ? ' is-stopped' : ''}`}>
      <p className="ta-who">Timmy {t.model ? <span className="ta-model-tag">{t.model}</span> : null} <span className="ta-when">{clock(t.at)}</span></p>
      {t.text ? <Markdown text={t.text} /> : <p className="ta-text">{t.stopped ? '(stopped before it answered)' : ''}</p>}
      {t.stopped ? <p className="ta-muted">Stopped{t.stopped.by ? ` by ${t.stopped.by}` : ''}.</p> : null}
      {r ? <p className="ta-receipt"><span className={r.verified ? 'ta-verified' : 'ta-unverified'}>{r.verified ? '✓ receipt' : '✕ receipt'}</span> <code>{r.id}</code> · {r.where}{r.ms ? ` · ${(r.ms / 1000).toFixed(1)} s` : ''}</p> : null}
    </li>
  );
}

function LiveTurn({ turn, theme, saved }) {
  if (!turn) return null;
  return (
    <>
      {saved ? null : <li className="ta-turn ta-you is-live"><p className="ta-who">You</p><p className="ta-text">{turn.message}</p></li>}
      <li className={`ta-turn ta-timmy is-live`} data-phase={turn.phase}>
        <p className="ta-who">Timmy {turn.route && turn.route.model ? <span className="ta-model-tag">{turn.route.model}</span> : null} <StateWord word={activityOf(turn) === 'idle' ? turn.phase : activityOf(turn)} /></p>
        {turn.text ? <Markdown text={turn.text} /> : turn.phase === 'running' ? <p className="ta-muted">{turn.route ? `Asking ${turn.route.where}…` : 'Opening the turn…'}</p> : null}
        {turn.tools.length ? <ul className="ta-tools">{turn.tools.map((x) => <li key={x.call}><StateWord word={x.status} /> {x.words}</li>)}</ul> : null}
        {turn.needsYou ? (
          <div className="ta-needs" role="alertdialog" aria-label="NEEDS YOU">
            <p className="ta-needs-head"><strong>NEEDS YOU</strong> · {turn.needsYou.tool}</p>
            <p>{turn.needsYou.words}</p>
            {turn.needsYou.detail ? <pre className="ta-detail">{String(turn.needsYou.detail).slice(0, 1200)}</pre> : null}
            <div className="ta-row ta-answers">
              {(turn.needsYou.options || ['once', 'deny']).map((o) => (
                <ActionFace key={o} theme={theme} name={`needs-you:${o}`} label={o === 'once' ? 'Allow once' : o === 'session' ? 'Allow for this session' : 'Deny'} onPress={() => answerNeedsYou(o)} />
              ))}
            </div>
          </div>
        ) : null}
        {turn.error ? <p className="ta-result" role="status">{turn.error}</p> : null}
        {turn.done ? <p className="ta-receipt">{turn.done.receipt ? <>receipt <code>{String(turn.done.receipt).slice(0, 15)}</code> · </> : null}{turn.done.status}{turn.done.model ? ` · ${turn.done.model}` : ''}{typeof turn.done.steps === 'number' ? ` · ${turn.done.steps} step${turn.done.steps === 1 ? '' : 's'}` : ''}{turn.done.costMeasured && typeof turn.done.costUsd === 'number' ? ` · $${turn.done.costUsd.toFixed(4)}` : ''}</p> : null}
      </li>
    </>
  );
}

/** Ways to begin, written into the composer (never sent by themselves). */
const STARTS = ['What can you help me with in this project?', 'Read the project’s files and summarise them.', 'Plan the next step with me.'];

export function ChatCard({ theme }) {
  const view = useApp((s) => s.view);
  const turn = useApp((s) => s.turn);
  const [draft, setDraft] = useState('');
  const list = useRef(null);
  const running = turn && ['running', 'stopping'].includes(turn.phase);
  const route = view ? view.route : null;
  const ready = route ? route.ready === true : false;
  const saved = view && view.conversation && Array.isArray(view.conversation.turns) ? view.conversation.turns : [];
  const elsewhere = view && view.conversation && Array.isArray(view.conversation.running) ? view.conversation.running : [];
  // the saved conversation, without the live turn's own two messages once the view has them (the live turn ends, the view reads again)
  const shown = useMemo(() => saved.slice(-60), [saved]);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [shown.length, turn && turn.text, turn && turn.tools.length, turn && turn.needsYou]);
  const submit = () => { const t = draft.trim(); if (!t || running || !ready) return; setDraft(''); send(t); };
  const onKey = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } };
  // the live turn's own messages once the saved conversation has them (the view is read again when the turn ends): the person's
  // message is not drawn twice, and an answered turn is the saved one (with its model and receipt); a failed or refused turn keeps
  // its words here, since nothing of it was saved as an answer
  const savedAt = (kind, text) => turn && saved.some((x) => x.kind === kind && (text === undefined || x.text === text) && Date.parse(x.at) >= Date.parse(turn.startedAt) - 5000);
  const messageSaved = !!(turn && savedAt('you', turn.message));
  const live = turn && !(turn.phase === 'done' && messageSaved && savedAt('timmy'));
  return (
    <Card id="chat" kicker="02 · CHAT" title={view && view.project ? `Timmy · ${view.project.name}` : 'Timmy'} className="ta-card-chat"
      tools={<><StateWord word={activityOf(turn)} /><Button onClick={newConversation} disabled={running}>New conversation</Button></>}>
      <ol className="ta-turns" ref={list} aria-label="The conversation" aria-live="polite">
        {!shown.length && !turn ? (
          <li className="ta-turn ta-hello">
            <p className="ta-text">{ready ? 'Say what you want to work on. Timmy runs the real agent here: its tools ask you first, and each answer is sealed with a receipt.' : 'Choose a model first (01 · Connect), then say what you want to work on.'}</p>
            {ready ? <div className="ta-row ta-starts">{STARTS.map((t) => <button key={t} type="button" className="ta-chip" onClick={() => setDraft(t)}>{t}</button>)}</div> : null}
          </li>
        ) : null}
        {shown.map((t, i) => <Turn key={`${t.at}-${i}`} t={t} />)}
        {live ? <LiveTurn turn={turn} theme={theme} saved={messageSaved} /> : null}
      </ol>
      {elsewhere.length ? <p className="ta-elsewhere" role="status">A turn of this project is running in {elsewhere.map((r) => `${surfaceWord(r.surface)} (since ${clock(r.since)})`).join(', ')}: this page’s Send waits for it.</p> : null}
      <div className="ta-composer">
        <textarea className="ta-input" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
          placeholder={ready ? 'Message Timmy  (⌘/Ctrl + Enter sends)' : 'Send is off until a model is chosen'} aria-label="Message Timmy" disabled={!view} />
        <div className="ta-composer-row">
          <p className="ta-route" title={route ? route.words : ''}>{route ? route.label : 'Reading the route…'}</p>
          {running ? <Button kind="primary" onClick={stop} disabled={turn.phase === 'stopping'}>{turn.phase === 'stopping' ? 'Stopping…' : 'Stop'}</Button>
            : <Button kind="primary" onClick={submit} disabled={!ready || !draft.trim()}>Send</Button>}
        </div>
        {view && !ready ? <p className="ta-muted">{route && route.words ? route.words.split('. ')[0] + '.' : ''} <button type="button" className="ta-link" onClick={() => goTo('connect')}>Choose a model →</button></p> : null}
      </div>
    </Card>
  );
}

export function ActivityCard({ theme }) {
  const turn = useApp((s) => s.turn);
  return (
    <Card id="activity" kicker="02 · AGENT" title="What the agent is doing" face={<ConsoleFace size="wide" theme={theme} />}>
      <Facts rows={[
        ['state', <StateWord key="s" word={activityOf(turn)} />],
        ['route', turn && turn.route ? `${turn.route.label}` : null],
        ['where', turn && turn.route ? turn.route.where : null],
        ['turn', turn && turn.id ? <code key="t">{turn.id}</code> : null],
        ['started', turn ? clock(turn.startedAt) : null],
        ['tools', turn && turn.tools.length ? turn.tools.map((x) => `${x.name} ${x.status}`).join(' · ') : null],
        ['receipt', turn && turn.done && turn.done.receipt ? <code key="r">{String(turn.done.receipt).slice(0, 15)}</code> : null],
      ]} />
      {!turn ? <p className="ta-muted">No turn on this page yet. The face moves with the turn’s own events (its route, each tool, NEEDS YOU, Stop and the end), never on its own.</p> : null}
    </Card>
  );
}

export function RouteCard() {
  const view = useApp((s) => s.view);
  const viewAt = useApp((s) => s.viewAt);
  if (!view) return <Card id="route" kicker="02 · ROUTE" title="Where the next turn goes"><Empty>Reading…</Empty></Card>;
  const c = view.choice || {};
  return (
    <Card id="route" kicker="02 · ROUTE" title="Where the next turn goes">
      <p className="ta-line"><StateWord word={view.route && view.route.ready ? 'ready' : 'Send is off'} live={false} /> {c.words || (view.route && view.route.label)}</p>
      {c.check ? <p className="ta-muted"><StateWord word={c.check.state} live={c.check.state === 'ready'} /> {c.check.words}</p> : null}
      <Facts rows={[
        ['chosen in', c.from || null],
        ['policy', view.policy ? `free only ${view.policy.freeOnly ? 'on' : 'off'} · local only ${view.policy.localOnly ? 'on' : 'off'}` : null],
        ['read', <span key="r" title={view.logs ? view.logs.words : ''}>{day(viewAt)}</span>],
      ]} />
    </Card>
  );
}

// ── 03 · REVIEW ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ReceiptsCard() {
  const view = useApp((s) => s.view);
  const turns = view && view.conversation && Array.isArray(view.conversation.turns) ? view.conversation.turns : [];
  const answers = turns.filter((t) => t.kind === 'timmy').slice(-40).reverse();
  return (
    <Card id="receipts" kicker="03 · PROOF" title="Each answer and its receipt">
      {!answers.length ? <Empty>{view ? 'No answer in this conversation yet.' : 'Reading the conversation…'}</Empty> : (
        <table className="ta-table">
          <thead><tr><th>When</th><th>Model</th><th>Where</th><th>Receipt</th><th>Answer</th></tr></thead>
          <tbody>
            {answers.map((t, i) => (
              <tr key={`${t.at}-${i}`}>
                <td>{day(t.at)}</td>
                <td>{t.model || '—'}</td>
                <td>{t.receipt ? t.receipt.where : '—'}</td>
                <td>{t.receipt ? <><span className={t.receipt.verified ? 'ta-verified' : 'ta-unverified'}>{t.receipt.verified ? '✓' : '✕'}</span> <code>{t.receipt.id}</code></> : <span className="ta-muted">none matched</span>}</td>
                <td className="ta-clip">{t.stopped ? '(stopped) ' : ''}{String(t.text || '').slice(0, 140)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function SummaryCard() {
  const view = useApp((s) => s.view);
  const turns = view && view.conversation && Array.isArray(view.conversation.turns) ? view.conversation.turns : [];
  const answers = turns.filter((t) => t.kind === 'timmy');
  const sealed = answers.filter((t) => t.receipt);
  const verified = sealed.filter((t) => t.receipt.verified);
  const models = [...new Set(answers.map((t) => t.model).filter(Boolean))];
  return (
    <Card id="summary" kicker="03 · THIS CONVERSATION" title="At a glance">
      <Facts rows={[
        ['messages', view && view.conversation ? String(view.conversation.total) : null],
        ['answers', String(answers.length)],
        ['with a receipt', String(sealed.length)],
        ['verified', String(verified.length)],
        ['models', models.length ? models.join(', ') : null],
        ['session', view && view.conversation ? <code key="s">{view.conversation.session}</code> : null],
      ]} />
      <div className="ta-row"><Button onClick={newConversation}>Start a new conversation</Button><Button onClick={() => goTo('chat')}>Back to the chat</Button></div>
    </Card>
  );
}

/** Each card by its id, the page it belongs to, and where it sits on the board (desk coordinates) and in a column. */
export const CARDS = Object.freeze({
  'models-here': { page: 'connect', C: ModelsHereCard, x: 0, y: 0, w: 520, h: 640 },
  providers: { page: 'connect', C: ProvidersCard, x: 556, y: 0, w: 544, h: 640 },
  // (below the page's two cards, outside its fit: the Providers card's "OpenRouter's catalog ↓" brings the board to it)
  catalog: { page: 'connect', C: CatalogCard, x: 0, y: 700, w: 1100, h: 480, fit: false },
  chat: { page: 'chat', C: ChatCard, x: 0, y: 0, w: 700, h: 640 },
  activity: { page: 'chat', C: ActivityCard, x: 736, y: 0, w: 364, h: 404 },
  route: { page: 'chat', C: RouteCard, x: 736, y: 428, w: 364, h: 212 },
  receipts: { page: 'review', C: ReceiptsCard, x: 0, y: 0, w: 736, h: 640 },
  summary: { page: 'review', C: SummaryCard, x: 772, y: 0, w: 328, h: 380 },
});
export const cardsOf = (page) => Object.entries(CARDS).filter(([, c]) => c.page === page).map(([id, c]) => ({ id, ...c }));
export { PAGES };
