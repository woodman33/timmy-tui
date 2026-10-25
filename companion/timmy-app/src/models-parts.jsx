// R12: the parts of model choice the Chat's context column and the Models & accounts page share — a model row, the starter
// download, the models on this computer (asked with permission first), OpenRouter's catalog, and one provider's card (its
// identity and its actions once; the endpoint and its links in Details). Every word comes from a companion answer.
import { Fragment, useEffect, useRef, useState } from 'react';
import { postJson } from './api.js';
import { ProviderFace } from './rive.jsx';
import { answerLocalPermission, cancelPull, checkProvider, choose, clearPull, confirmPull, loadModels, setSearch, startPull, useApp } from './store.js';
import { Button, Empty, Out, StateWord } from './ui.jsx';

export const PROVIDER_NAMES = { openrouter: 'OpenRouter', 'ollama-local': 'Ollama on this computer', 'ollama-cloud': 'Ollama cloud', cloudflare: 'Cloudflare' };
export const providerName = (id) => PROVIDER_NAMES[id] || id;
export const providerOf = (view, id) => (view && Array.isArray(view.providers) ? view.providers.find((p) => p.id === id) : null);
export const chosenOf = (view) => (view && view.choice && view.choice.chosen ? { source: view.choice.source, model: view.choice.model } : null);
export const whereOf = (route) => (!route ? '' : route.kind === 'local' ? (route.cloud ? 'Ollama cloud' : 'this computer') : route.kind === 'openrouter' ? 'OpenRouter' : 'no route');
const isLive = (w) => w === 'checked' || w === 'connected';

const sizeOf = (row) => (row && typeof row.size === 'number' ? (row.size >= 1e9 ? `${(row.size / 1e9).toFixed(1)} GB` : `${Math.round(row.size / 1e6)} MB`) : null);
const priceOf = (row) => {
  const p = row && row.price;
  if (!p) return null;
  if (p.free === true) return 'free';
  if (p.free === 'unknown') return 'price unknown';
  const f = (n) => (typeof n === 'number' ? `$${n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 2 : 0)}` : '?');
  return `${f(p.inPerM)} in · ${f(p.outPerM)} out /M${p.varies ? ' (varies)' : ''}`;
};
const capsOf = (row) => ['tools', 'vision', 'reasoning'].filter((k) => ((row && row.caps) || {})[k] === true);

export function ModelRow({ row, source, chosen, onUse, busy, compact = false }) {
  const inUse = chosen && chosen.model === row.id;
  const caps = capsOf(row);
  return (
    <li className={`ta-model${inUse ? ' is-chosen' : ''}${compact ? ' is-compact' : ''}`} data-model={row.id}>
      <div className="ta-model-main">
        <span className="ta-model-id" title={row.id}>{row.id}</span>
        <span className="ta-model-meta">
          {!compact && row.maker && row.maker !== 'unknown' ? <span>{row.maker}</span> : null}
          {sizeOf(row) ? <span>{sizeOf(row)}</span> : null}
          {row.contextLength ? <span>{Math.round(row.contextLength / 1000)}k</span> : null}
          {source === 'openrouter' && priceOf(row) ? <span>{priceOf(row)}</span> : null}
          {(compact ? caps.slice(0, 1) : caps).map((c) => <span key={c} className="ta-cap">{c}</span>)}
          {row.loaded ? <span className="ta-cap">loaded</span> : null}
        </span>
      </div>
      {inUse ? <span className="ta-in-use" aria-label={`${row.id} is the chat's model`}>in use</span>
        : onUse ? <Button kind="quiet" disabled={busy} onClick={() => onUse(row)} aria-label={`Use ${row.id} for the chat`}>Use</Button>
          : <span className="ta-muted">runs on Ollama’s servers</span>}
    </li>
  );
}

export function Pull() {
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

/** The permission question, asked on the page before Timmy asks this computer's Ollama anything. */
export function LocalAsk({ compact = false }) {
  const permission = useApp((s) => s.localPermission);
  return (
    <div className="ta-ask" data-permission={permission}>
      <p className="ta-ask-q"><strong>May Timmy look for the models on this computer?</strong></p>
      {compact ? <p className="ta-muted">Timmy asks this computer’s Ollama for its list. No model runs and nothing is downloaded.</p>
        : <p>Timmy asks the Ollama on this computer for its list of models (its <code>/api/tags</code>, then <code>/api/show</code> for each). No model runs, nothing is downloaded, and nothing leaves this computer. Cloud models your Ollama account adds (names ending in <code>:cloud</code>) are listed too.</p>}
      {permission === 'declined' ? <p className="ta-muted">You said not now. Nothing has been asked.</p> : null}
      <div className="ta-row">
        <Button kind="primary" onClick={() => answerLocalPermission(true)}>Yes, look for models</Button>
        {permission === 'unasked' ? <Button onClick={() => answerLocalPermission(false)}>Not now</Button> : null}
      </div>
    </div>
  );
}

/** The chat models on this computer (with permission), the starters when there are none, and a download in progress. */
export function LocalModels({ compact = false, limit = 0 }) {
  const view = useApp((s) => s.view);
  const permission = useApp((s) => s.localPermission);
  const local = useApp((s) => s.models['ollama-local']);
  const check = useApp((s) => s.check['ollama-local']);
  const choosing = useApp((s) => s.choosing);
  const config = useApp((s) => s.config);
  const pull = useApp((s) => s.pull);
  if (permission !== 'granted') return <LocalAsk compact={compact} />;
  const p = providerOf(view, 'ollama-local');
  const state = check && check.state ? check.state : p ? p.state : 'not asked';
  const rows = local && Array.isArray(local.rows) ? local.rows : [];
  const shown = limit ? rows.slice(0, limit) : rows;
  const chosen = chosenOf(view);
  const starters = config && config.ollama && Array.isArray(config.ollama.starters) ? config.ollama.starters : [];
  const install = config && config.ollama ? config.ollama.install : null;
  return (
    <div className="ta-local">
      <p className="ta-line"><StateWord word={state} live={isLive(state)} /> <span className="ta-muted">{check && check.words ? check.words : local && local.words ? local.words : 'Asking…'}</span></p>
      {shown.length ? (
        <ul className="ta-models" aria-label="Chat models on this computer">
          {shown.map((r) => <ModelRow key={r.id} row={r} source="ollama-local" compact={compact} chosen={chosen && chosen.source === 'ollama-local' ? chosen : null} onUse={(row) => choose('ollama-local', row.id)} busy={!!choosing} />)}
        </ul>
      ) : local ? (
        <div className="ta-none">
          <Empty>{local.listed ? `Ollama lists ${local.listed}, none of them a local chat model${local.left ? ` (${local.left})` : ''}.` : 'No chat model is installed here yet.'}</Empty>
          {state === 'not installed' && install ? <p className="ta-muted">Install Ollama: {install.install}. Then {install.start}. <Out href={install.link}>Ollama’s download page</Out></p> : null}
          {starters.length && state !== 'not installed' ? (
            <div className="ta-starters">
              <p className="ta-muted">Download a starter model into Ollama (you see its size and confirm first):</p>
              {starters.map((s) => (
                <div key={s.model} className="ta-starter">
                  <span><code>{s.model}</code> · {s.size}{compact ? '' : ` · ${s.use}`}</span>
                  <Button disabled={!!pull} onClick={() => startPull(s.model)}>Download…</Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {limit && rows.length > limit ? <p className="ta-muted">{rows.length - limit} more on Models &amp; accounts.</p> : null}
      <Pull />
    </div>
  );
}

/** The cloud models an Ollama account adds (listed; chat on them is set up with a key from Ollama). */
export function CloudModels() {
  const view = useApp((s) => s.view);
  const permission = useApp((s) => s.localPermission);
  const cloud = useApp((s) => s.models['ollama-cloud']);
  const rows = cloud && Array.isArray(cloud.rows) ? cloud.rows : [];
  const pc = providerOf(view, 'ollama-cloud');
  if (permission !== 'granted') return <Empty>Listed with the models on this computer, once you allow Timmy to look.</Empty>;
  return rows.length ? (
    <>
      <ul className="ta-models" aria-label="Ollama cloud models">{rows.map((r) => <ModelRow key={r.id} row={r} source="ollama-cloud" chosen={chosenOf(view)} onUse={null} />)}</ul>
      <p className="ta-muted">These run on Ollama’s computers under your Ollama account, not on this one. {pc && pc.next ? pc.next : ''}</p>
    </>
  ) : <Empty>{cloud ? cloud.words || cloud.error || 'None listed.' : 'Not asked yet.'}</Empty>;
}

/** OpenRouter's catalog (the copy this computer keeps), searched; Use writes the setup's choice. */
export function Catalog({ compact = false, limit = 0 }) {
  const view = useApp((s) => s.view);
  const m = useApp((s) => s.models.openrouter);
  const search = useApp((s) => s.search.openrouter);
  const asking = useApp((s) => s.modelsAsking.openrouter);
  const choosing = useApp((s) => s.choosing);
  const timer = useRef(0);
  useEffect(() => { if (!m && !asking) loadModels('openrouter'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onSearch = (e) => { setSearch('openrouter', e.target.value); clearTimeout(timer.current); timer.current = setTimeout(() => loadModels('openrouter'), 250); };
  const rows = m && Array.isArray(m.rows) ? m.rows : [];
  const shown = limit ? rows.slice(0, limit) : rows;
  const chosen = chosenOf(view);
  return (
    <div className="ta-catalog">
      <input className="ta-search" type="search" placeholder="Search OpenRouter’s models" value={search} onChange={onSearch} aria-label="Search OpenRouter's models" />
      <p className="ta-muted">{m ? `${m.words || ''}${typeof m.matched === 'number' ? ` · ${m.matched} of ${m.all} match` : ''}` : 'Reading the catalog this computer keeps…'}</p>
      {shown.length ? (
        <ul className={`ta-models${compact ? '' : ' ta-models-grid'}`} aria-label="OpenRouter models">
          {shown.map((r) => <ModelRow key={r.id} row={r} source="openrouter" compact={compact} chosen={chosen && chosen.source === 'openrouter' ? chosen : null} onUse={(row) => choose('openrouter', row.id)} busy={!!choosing} />)}
        </ul>
      ) : m ? <Empty>No model matches.</Empty> : null}
    </div>
  );
}

/** What the last Use answered (the setup's write path), said once. */
export function ChooseResult({ source }) {
  const r = useApp((s) => s.chooseResult);
  if (!r || (source && r.source !== source)) return null;
  return <p className={`ta-result${r.ok ? ' is-ok' : ''}`} role="status">{r.words || r.error}</p>;
}

async function startOpenRouterSignIn() {
  const r = await postJson('/api/connections/openrouter/start', { callback: `${location.origin}/api/connections/openrouter/callback` });
  if (r.ok && r.url) window.open(r.url, '_blank', 'noopener');
  return r;
}

/**
 * One provider: its Rive face (the state drawn), its name and state word once, its one line, its actions once; the endpoint,
 * what to do next and its links in Details. (Before: the face's own caption, the name and the words were each said twice.)
 */
export function ProviderCard({ p, theme, compact = false }) {
  const view = useApp((s) => s.view);
  const c = useApp((s) => s.check[p.id]);
  const [signIn, setSignIn] = useState(null);
  const word = c && c.state ? c.state : p.state;
  const words = c && c.words ? c.words : p.words;
  const source = c ? `POST /api/connections/${p.id}/check` : 'GET /api/chat/view (providers)';
  const ready = view && view.route && view.route.ready;
  const canCheck = p.id === 'openrouter' || p.id === 'ollama-local';
  return (
    <article className={`ta-provider${compact ? ' is-compact' : ''}`} data-provider={p.id}>
      <ProviderFace provider={p.id} name={providerName(p.id)} state={word} source={source} theme={theme} size="card" />
      <div className="ta-provider-words">
        <h3 className="ta-provider-name">{providerName(p.id)} <StateWord word={word} live={isLive(word)} /></h3>
        <p className="ta-provider-line">{words}</p>
        <div className="ta-row">
          {p.id === 'openrouter' && p.state === 'not set up' ? <Button kind={ready ? 'quiet' : 'primary'} onClick={async () => setSignIn(await startOpenRouterSignIn())}>Sign in with OpenRouter</Button> : null}
          {canCheck ? <Button onClick={() => checkProvider(p.id)} disabled={word === 'checking'}>{word === 'checking' ? 'Checking…' : 'Check'}</Button> : null}
        </div>
        {signIn ? <p className="ta-muted" role="status">{signIn.words || signIn.error}</p> : null}
        <details className="ta-details">
          <summary>Details</summary>
          <dl className="ta-facts">
            {(p.lines || []).map((l, i) => <Fragment key={i}><dt>{i ? '' : 'facts'}</dt><dd>{l}</dd></Fragment>)}
            {p.next ? <><dt>next</dt><dd>{p.next}</dd></> : null}
            {p.at ? <><dt>observed</dt><dd>{new Date(p.at).toLocaleString()}</dd></> : null}
            <dt>read from</dt><dd><code>{source}</code></dd>
            {c && c.at ? <><dt>checked</dt><dd>{new Date(c.at).toLocaleTimeString()}</dd></> : null}
          </dl>
          {(p.links || []).length ? <div className="ta-row">{p.links.slice(0, 3).map((l) => <Out key={l.url} href={l.url}>{l.label}</Out>)}</div> : null}
        </details>
      </div>
    </article>
  );
}
