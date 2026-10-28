// The unified Workspace order (2026-10-27): the ONE integration catalog (GET /api/catalog: src/capabilities/catalog.ts) as one
// searchable list, used by Tools & integrations, the Workspace's node picker and the Control Room. Each row keeps its source
// registry and namespaced id, its operations (and where each starts today), the adapter that routes it, its setup blocker,
// and six facts kept apart — researched, installed, configured, discovered, callable, verified here — each ✓ (true), – (false)
// or ? (not read on this surface), with its words and source one disclosure away. Installed is not callable; a listed name is
// not an integration that works.
import { useEffect, useMemo, useState } from 'react';
import { getJson } from './api.js';
import { projectQuery, useApp } from './store.js';
import { Empty } from './ui.jsx';

export const STATE_WORDS = Object.freeze({ researched: 'researched', installed: 'installed', configured: 'configured', discovered: 'discovered', callable: 'callable', verified: 'verified here' });
const REGISTRY_WORDS = Object.freeze({ inventory: 'Capability inventory', lanes: 'Agent lanes', native: 'Native engines', vision: 'Vision adapters', providers: 'Providers', apps: 'Hosted apps', connectors: 'Connectors', workflows: 'Workflow runner' });
const KIND_WORDS = Object.freeze({ model: 'model', tool: 'tool', mcp: 'MCP', lane: 'lane', harness: 'harness', vision: 'vision', native: 'native', provider: 'provider', app: 'app', connector: 'connector' });
export const SHOWS = Object.freeze([
  ['all', 'Everything'],
  ['callable', 'Callable now'],
  ['installed-not-callable', 'Installed, not callable'],
  ['setup', 'Needs setup'],
  ['metadata', 'Metadata only'],
]);
const mark = (ok) => (ok === true ? '✓' : ok === false ? '–' : '?');
const SHORT = Object.freeze({ researched: 'res', installed: 'inst', configured: 'conf', discovered: 'disc', callable: 'call', verified: 'ver' });
const said = (ok) => (ok === true ? 'yes' : ok === false ? 'no' : 'not read here');

/** The catalog for the page's project (one reading per project; `refresh` reads again). */
export function useCatalog() {
  const project = useApp((s) => (s.config && s.config.project ? s.config.project.root : ''));
  const [r, setR] = useState(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let gone = false;
    setR(null);
    getJson(`/api/catalog${projectQuery()}${n ? `${projectQuery() ? '&' : '?'}refresh=1` : ''}`).then((x) => { if (!gone) setR(x); });
    return () => { gone = true; };
  }, [project, n]);
  return { answer: r, refresh: () => setN((x) => x + 1) };
}

/** Whether an entry shows under a "Show" choice. */
export function shows(e, show) {
  if (show === 'callable') return e.states.callable.ok === true;
  if (show === 'installed-not-callable') return e.states.installed.ok === true && e.states.callable.ok !== true;
  if (show === 'setup') return Boolean(e.setup) && !e.metadataOnly;
  if (show === 'metadata') return Boolean(e.metadataOnly);
  return true;
}
/** Whether an entry matches the search words (its name, id, kind, registry, operations, adapter). */
export function matches(e, words) {
  const w = String(words || '').trim().toLowerCase();
  if (!w) return true;
  const hay = [e.name, e.id, e.kind, ...e.sources.map((s) => `${s.registry} ${REGISTRY_WORDS[s.registry] || ''}`), ...e.operations.map((o) => `${o.label} ${o.id}`), e.adapter || ''].join(' ').toLowerCase();
  return w.split(/\s+/).every((t) => hay.includes(t));
}

function EntryFacts({ e, states }) {
  return (
    <dl className="ta-facts tx-cat-facts">
      {states.map((s) => (
        <div key={s} className="ta-fact" data-fact={s} data-ok={said(e.states[s].ok)}>
          <dt>{STATE_WORDS[s]} · {said(e.states[s].ok)}</dt>
          <dd>{e.states[s].words} <span className="ta-muted">({e.states[s].source})</span></dd>
        </div>
      ))}
    </dl>
  );
}

function EntryRow({ e, states, pick, pickLabel }) {
  const canPick = typeof pick === 'function' && pick(e) !== false;
  return (
    <li className="tx-cat-row" data-catalog-entry={e.id} data-kind={e.kind} data-callable={said(e.states.callable.ok)} data-metadata={e.metadataOnly ? 'yes' : 'no'}>
      <div className="tx-cat-head">
        <span className="tx-cat-name">{e.name}</span>
        <span className="tx-cat-kind">{KIND_WORDS[e.kind] || e.kind}</span>
        <span className="tx-cat-src" title={e.sources.map((s) => `${s.file} · ${s.id}`).join('\n')}>{e.sources.map((s) => REGISTRY_WORDS[s.registry] || s.registry).join(' + ')}</span>
        <span className="tx-cat-marks" aria-label={states.map((s) => `${STATE_WORDS[s]}: ${said(e.states[s].ok)}`).join(', ')}>
          {states.map((s) => <span key={s} data-state={s} data-ok={said(e.states[s].ok)} title={`${STATE_WORDS[s]}: ${e.states[s].words}`} aria-hidden="true"><small>{SHORT[s] || s}</small>{mark(e.states[s].ok)}</span>)}
        </span>
        {canPick ? <button type="button" className="ta-btn ta-btn-quiet tx-cat-pick" data-action="catalog-pick" onClick={() => pick(e, true)}>{pickLabel || 'Use'}</button> : null}
      </div>
      {e.setup ? <p className="tx-cat-setup" data-setup>{e.metadataOnly ? '' : e.states.callable.ok === true ? 'Next: ' : 'Setup: '}{e.setup}</p> : null}
      <details className="ta-details">
        <summary>Details · <code>{e.id}</code></summary>
        <EntryFacts e={e} states={states} />
        <p className="ta-muted">Adapter: {e.adapter || 'none (metadata only)'}{e.role ? ` · ${e.role}` : ''}</p>
        {e.operations.length ? (
          <ul className="tx-cat-ops">
            {e.operations.map((o) => <li key={o.id} data-op={o.id}><b>{o.label}</b> — {o.where.join(', ')}: <span className="ta-muted">{o.how}</span></li>)}
          </ul>
        ) : <p className="ta-muted">No operation is offered for it here.</p>}
      </details>
    </li>
  );
}

/**
 * The catalog list: search, a registry and a "Show" choice, then the rows. `filter(e)` narrows it for a surface (the node
 * picker shows what can be a node; the Control Room, the harnesses); `pick(e)` adds a Use button where it returns true.
 */
export function CatalogList({ filter = null, pick = null, pickLabel = 'Use', label = 'Search integrations', initialShow = 'all', limit = 0 }) {
  const { answer, refresh } = useCatalog();
  const [words, setWords] = useState('');
  const [registry, setRegistry] = useState('all');
  const [show, setShow] = useState(initialShow);
  const catalog = answer && answer.ok ? answer.catalog : null;
  const states = catalog ? catalog.states : [];
  const rows = useMemo(() => (catalog ? catalog.entries.filter((e) => (!filter || filter(e)) && (registry === 'all' || e.sources.some((s) => s.registry === registry)) && shows(e, show) && matches(e, words)) : []), [catalog, filter, registry, show, words]);
  if (!answer) return <Empty>Reading the catalog…</Empty>;
  if (!answer.ok) return <Empty>{answer.error || 'The companion did not answer the catalog.'}</Empty>;
  const shown = limit > 0 ? rows.slice(0, limit) : rows;
  return (
    <div className="tx-cat" data-catalog={catalog.entries.length} data-shown={rows.length}>
      <div className="tx-cat-bar">
        <label className="tx-cat-search">
          <span className="tr-visually-hidden">{label}</span>
          <input type="search" value={words} placeholder={label} aria-label={label} onChange={(ev) => setWords(ev.target.value)} data-catalog-search />
        </label>
        <label>
          <span className="tr-visually-hidden">Registry</span>
          <select value={registry} onChange={(ev) => setRegistry(ev.target.value)} aria-label="Registry" data-catalog-registry>
            <option value="all">Every registry</option>
            {catalog.registries.map((r) => <option key={r.registry} value={r.registry}>{REGISTRY_WORDS[r.registry] || r.registry} ({r.entries})</option>)}
          </select>
        </label>
        <label>
          <span className="tr-visually-hidden">Show</span>
          <select value={show} onChange={(ev) => setShow(ev.target.value)} aria-label="Show" data-catalog-show>
            {SHOWS.map(([v, w]) => <option key={v} value={v}>{w}</option>)}
          </select>
        </label>
        <button type="button" className="ta-btn ta-btn-quiet" onClick={refresh} data-action="catalog-refresh">Read again</button>
      </div>
      <p className="ta-muted tx-cat-legend">
        {states.map((s) => STATE_WORDS[s]).join(' · ')} — ✓ read from its record, – not true, ? not read on this page. {rows.length} of {catalog.entries.length} shown.
        {catalog.registries.filter((r) => r.error).map((r) => <span key={r.registry} className="tx-cat-gap" data-registry-gap={r.registry}> {REGISTRY_WORDS[r.registry] || r.registry}: {r.error}.</span>)}
      </p>
      {shown.length ? <ul className="tx-cat-rows">{shown.map((e) => <EntryRow key={e.id} e={e} states={states} pick={pick} pickLabel={pickLabel} />)}</ul> : <Empty>Nothing in the catalog matches.</Empty>}
      {limit > 0 && rows.length > limit ? <p className="ta-muted">{rows.length - limit} more: narrow the search.</p> : null}
    </div>
  );
}
