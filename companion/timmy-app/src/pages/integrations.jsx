// The 2026-10-27 shared-integrator order: Tools & integrations' cards for Treg and tldraw. Each card keeps five words apart —
// installed, signed in, discovered, ran here, qualified — and names the record each was read from (the companion's
// /api/connectors: src/companion/connector-ops.ts). Treg's work runs as the host's operations (durable, with Stop and Recover):
// Discover, a catalog search, the balance and a price preview are free; a paid call is proposed from a price preview, shows
// its quote, and runs once only after Approve. The tldraw card puts a finished operation's result on the Canvas desk as a
// note: the same host result, never a second way to call anything. No credential is ever on this page.
import { useEffect, useMemo, useRef, useState } from 'react';
import { getJson, postJson } from '../api.js';
import { placeOnCanvas, projectQuery, useApp } from '../store.js';
import { Button, Empty, Facts, StateWord, clock, day } from '../ui.jsx';

const q = () => projectQuery('?');
const usd = (n) => (typeof n !== 'number' ? '' : n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}` : `$${n.toFixed(2)}`);
const RUNGS = [['installed', 'installed'], ['signed_in', 'signed in'], ['discovered', 'discovered'], ['ran_here', 'ran here'], ['qualified', 'qualified']];
const TOOL_WORDS = { catalog_search: 'Catalog search', catalog_get: 'Price preview', balance: 'Balance', call: 'Paid call' };

function Ladder({ rungs }) {
  return (
    <ol className="tx-int-ladder" aria-label="What is known, each from its record">
      {rungs.map(([word, r]) => (
        <li key={word} data-rung={word} data-ok={r && r.ok ? 'yes' : 'no'}>
          <span className="tx-int-rung"><StateWord word={r && r.ok ? word : `not ${word}`} live={!!(r && r.ok)} /></span>
          <span className="tx-int-words">{r ? r.words : 'not read'}{r && r.at ? <span className="ta-muted"> · {day(r.at)}</span> : null}</span>
        </li>
      ))}
    </ol>
  );
}

function opLabel(o) { return o.kind === 'discover' ? 'Discover' : TOOL_WORDS[o.tool] || o.tool; }
function costWords(o) {
  if (!o.paid) return 'free';
  if (o.charged) return `${usd(o.charged.usd)} charged (Treg’s ${o.charged.field})`;
  if (o.approved) return `${usd(o.approved.quote.usd)} quoted${o.live ? '' : ' · charge not stated'}`;
  return 'may charge';
}

/** The note the Canvas gets for an operation: what it was, how it ended, its ids and receipt, its cost, where its answer is. */
export function noteOf(op) {
  return [`Treg · ${opLabel(op)}${op.args && op.args.endpoint_id ? ` ${op.args.endpoint_id}` : ''}${op.args && typeof op.args.query === 'string' ? ` “${op.args.query}”` : ''}`,
    `${op.state} · operation ${op.id}${op.receipt ? ` · receipt ${op.receipt}` : ''}`,
    op.paid ? costWords(op) : 'free lookup',
    op.mcp && op.mcp.output ? `answer: ${op.mcp.output}` : ''].filter(Boolean).join('\n');
}

function OpDetail({ op, onStop, onRecover, busy }) {
  if (!op) return null;
  const summary = noteOf(op);
  return (
    <div className="tx-int-op" data-op={op.id} data-op-state={op.state}>
      <p className="ta-line"><StateWord word={op.state} live={op.state === 'answered'} /> <strong>{opLabel(op)}</strong> <span className="ta-muted">· {op.route === 'sdk' ? 'SDK route' : 'MCPorter'} · {clock(op.started_at)} · {costWords(op)}</span></p>
      {op.why ? <p className="ta-muted">{op.why}</p> : null}
      <p className="tx-int-next"><span className="ta-context-k">NEXT</span> {op.next}</p>
      <Facts rows={[
        ['operation', <code key="o">{op.id}</code>],
        ['act', op.operation ? <code key="a">{op.operation}</code> : null],
        ['MCP call', op.mcp ? <span key="m"><code>{op.mcp.record}</code>{op.mcp.receipt ? <> · receipt <code>{op.mcp.receipt}</code></> : ' · no verified receipt'}</span> : null],
        ['receipt', op.receipt ? <code key="r">{op.receipt}</code> : null],
        ['quote', op.quote ? `${usd(op.quote.usd)} ${op.quote.type ? op.quote.type.replace(/_/g, ' ') : ''}${op.quote.note ? ` · ${op.quote.note}` : ''}${op.quote.checked ? ` · checked ${op.quote.checked}` : ''}` : op.approved ? `${usd(op.approved.quote.usd)} (approved ${clock(op.approved.at)})` : null],
        ['charged', op.paid ? (op.charged ? `${usd(op.charged.usd)} — Treg’s answer, field ${op.charged.field}` : op.live ? 'not yet known' : 'not stated in Treg’s answer: Treg’s history says') : null],
        ['balance', op.balance ? `${op.balance.usd !== null ? usd(op.balance.usd) : ''}${op.balance.micro !== null ? ` (${op.balance.micro} micro-dollars)` : ''} — Treg’s figure` : null],
        ['tools', op.discovered ? op.discovered.tools.map((t) => t.name).join(', ') : null],
      ]} />
      {op.discovered ? (
        <details className="ta-details"><summary>What Treg says of its tools (its own words; untrusted)</summary>
          <ul className="tx-tools-notes">{op.discovered.tools.map((t) => <li key={t.name}><strong>{t.name}</strong> ({t.params.join(', ')}): {t.description || '—'}</li>)}</ul>
        </details>
      ) : null}
      {op.log && op.log.length ? <pre className="tx-tools-pre" aria-label="act’s progress">{op.log.join('\n')}</pre> : null}
      {op.answer ? (
        <div className="tx-tools-answer">
          <p className="ta-context-k">TREG’S ANSWER · provider data, untrusted · research, not admitted evidence</p>
          <pre className="tx-tools-pre" data-answer>{op.answer}</pre>
        </div>
      ) : null}
      <div className="ta-row">
        {op.live && op.kind === 'call' ? <Button onClick={() => onStop(op)} disabled={!!busy || op.state === 'stopping'}>{op.state === 'stopping' ? 'Stopping…' : 'Stop'}</Button> : null}
        {op.state === 'interrupted' && op.kind === 'call' ? <Button kind="primary" onClick={() => onRecover(op)} disabled={!!busy}>Recover</Button> : null}
        {!op.live && op.answer ? <Button onClick={() => placeOnCanvas(summary, op.id)} data-action="to-canvas">Put on the Canvas</Button> : null}
      </div>
    </div>
  );
}

export function TregCard({ data, reload, picked, setPicked }) {
  const [route, setRoute] = useState('sdk');
  const [query, setQuery] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [request, setRequest] = useState('{}');
  const [proposal, setProposal] = useState(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState('');
  const t = data && data.treg;
  const ops = (data && Array.isArray(data.ops) ? data.ops : []);
  const op = ops.find((o) => o.id === picked) || null;
  const lastPrice = ops.find((o) => o.tool === 'catalog_get' && o.state === 'answered' && o.quote);
  const parsed = (() => { try { const v = JSON.parse(request || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } })();
  const run = async (what, path, body) => {
    setBusy(what); setSaid('');
    const r = await postJson(`/api/connectors/${path}${q()}`, body);
    setBusy('');
    if (!r.ok) { setSaid(r.error || `The companion answered ${r.status}.`); return null; }
    if (r.op) setPicked(r.op.id);
    await reload();
    return r;
  };
  const free = (tool, args) => run(tool, 'treg/ops', { tool, args, route });
  const propose = async () => {
    if (!lastPrice || !parsed) return;
    const r = await run('propose', 'treg/propose', { price_op: lastPrice.id, request: parsed, route });
    if (r && r.proposal) setProposal(r.proposal);
  };
  const approve = async () => { if (!proposal) return; const p = proposal; setProposal(null); await run('approve', 'treg/ops', { proposal: p.id }); };
  if (!data) return <Empty>Reading the Treg connection…</Empty>;
  if (!data.ok) return <Empty>{data.error || 'The companion did not answer.'}</Empty>;
  const can = t.operator && t.installed.ok && t.signed_in.ok;
  const searchHits = (() => {
    const s = ops.find((o) => o.tool === 'catalog_search' && o.state === 'answered' && o.answer);
    if (!s) return [];
    try { const v = JSON.parse(s.answer); return Array.isArray(v.results) ? v.results.slice(0, 8) : []; } catch { return []; }
  })();
  return (
    <article className="tx-int-card" data-connector="treg" aria-label={t.title}>
      <header className="tx-int-head">
        <h3 className="tx-int-title">{t.title}</h3>
        <span className="ta-muted">the operator’s Treg sign-in · {t.routes.filter((r) => r.available).length} routes</span>
      </header>
      <Ladder rungs={RUNGS.map(([k, w]) => [w, t[k]])} />
      <p className="tx-int-next"><span className="ta-context-k">NEXT</span> {t.next}</p>
      <div className="tx-int-controls">
        <div className="tx-tools-field">Route
          <div className="ta-seg" role="radiogroup" aria-label="Through which route">
            {t.routes.map((r) => <button key={r.id} type="button" role="radio" aria-checked={route === r.id} aria-pressed={route === r.id} disabled={!r.available} onClick={() => setRoute(r.id)}>{r.id === 'sdk' ? 'SDK' : 'MCPorter'}</button>)}
          </div>
        </div>
        <Button onClick={() => run('discover', 'treg/discover', { route })} disabled={!can || !!busy}>{busy === 'discover' ? 'Discovering…' : 'Discover tools · free'}</Button>
        <Button onClick={() => free('balance', {})} disabled={!can || !!busy}>Balance · free</Button>
      </div>
      <form className="tx-int-form" onSubmit={(e) => { e.preventDefault(); if (query.trim()) free('catalog_search', { query, limit: 5 }); }}>
        <label className="tx-tools-field">What do you want to do?
          <input className="tx-int-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="backlinks for a domain" maxLength={200} disabled={!can} />
        </label>
        <Button type="submit" kind="primary" disabled={!can || !!busy || !query.trim()}>Search the catalog · free</Button>
      </form>
      {searchHits.length ? (
        <ul className="tx-int-hits" aria-label="The last search’s endpoints (Treg’s words)">
          {searchHits.map((h) => (
            <li key={h.endpoint_id}>
              <button type="button" className="tx-tools-name" onClick={() => setEndpoint(h.endpoint_id)}>{h.endpoint_id}</button>
              <span className="ta-muted"> · {h.name || ''}{typeof h.usd_per_call === 'number' ? ` · listed ${usd(h.usd_per_call)} a call` : ''}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="tx-int-form" onSubmit={(e) => { e.preventDefault(); if (endpoint.trim()) free('catalog_get', { endpoint_id: endpoint.trim() }); }}>
        <label className="tx-tools-field">Endpoint id
          <input className="tx-int-input" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="tikhub.tiktok.user.profile" maxLength={160} disabled={!can} />
        </label>
        <Button type="submit" disabled={!can || !!busy || !endpoint.trim()}>Preview its price · free</Button>
      </form>
      {lastPrice ? (
        <div className="tx-int-propose" data-price-op={lastPrice.id}>
          <p className="ta-line"><strong>{lastPrice.quote.endpoint_id}</strong> <span className="ta-muted">· Treg quotes {usd(lastPrice.quote.usd)} {lastPrice.quote.type ? lastPrice.quote.type.replace(/_/g, ' ') : ''} · preview {lastPrice.id}, {clock(lastPrice.ended_at)}</span></p>
          <label className="tx-tools-field">Request (params, method, query, body; JSON)
            <textarea className="tx-tools-args" rows={3} value={request} onChange={(e) => setRequest(e.target.value)} spellCheck={false} aria-invalid={!parsed} />
          </label>
          <Button onClick={propose} disabled={!can || !!busy || !parsed}>{busy === 'propose' ? 'Proposing…' : 'Propose this call'}</Button>
        </div>
      ) : null}
      {proposal ? (
        <div className="tx-int-proposal" role="group" aria-label="A paid call, waiting for your approval" data-proposal={proposal.id}>
          <p className="tx-int-quote"><span className="tx-int-price">{usd(proposal.quote.usd)}</span> <span className="ta-muted">quoted for one call of {proposal.endpoint_id} · until {clock(proposal.expires_at)}</span></p>
          <ul className="tx-tools-notes">{proposal.words.map((w, i) => <li key={i}>{w}</li>)}</ul>
          <details className="ta-details"><summary>What will be sent</summary><pre className="tx-tools-pre">{JSON.stringify({ endpoint_id: proposal.endpoint_id, ...proposal.request, idempotency_key: proposal.idempotency_key }, null, 2)}</pre></details>
          <div className="ta-row">
            <Button kind="primary" onClick={approve} disabled={!!busy} data-action="approve">Approve and call once · {usd(proposal.quote.usd)} quoted</Button>
            <Button onClick={() => setProposal(null)}>Do not call</Button>
          </div>
        </div>
      ) : null}
      {said ? <p className="ta-result" role="alert">{said}</p> : null}
      {ops.length ? (
        <table className="ta-table tx-int-ops" aria-label="This project’s Treg operations">
          <thead><tr><th>When</th><th>What</th><th>State</th><th>Cost</th><th>Receipt</th></tr></thead>
          <tbody>
            {ops.slice(0, 12).map((o) => (
              <tr key={o.id} aria-selected={picked === o.id}>
                <td>{clock(o.started_at)}</td>
                <td><button type="button" className="tx-tools-name" onClick={() => setPicked(o.id)}>{opLabel(o)}{o.args && o.args.endpoint_id ? ` ${o.args.endpoint_id}` : ''}{o.args && typeof o.args.query === 'string' ? ` “${o.args.query.slice(0, 24)}”` : ''}</button></td>
                <td><StateWord word={o.state} live={o.state === 'answered'} /></td>
                <td>{costWords(o)}</td>
                <td>{o.receipt ? <code>{o.receipt}</code> : <span className="ta-muted">{o.kind === 'discover' ? 'a listing is not sealed' : 'none yet'}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <OpDetail op={op} busy={busy} onStop={(o) => run('stop', `ops/${o.id}/stop`, {})} onRecover={(o) => run('recover', `ops/${o.id}/recover`, {})} />
    </article>
  );
}

export function TldrawCard({ picked }) {
  const config = useApp((s) => s.config);
  const lic = useApp((s) => s.license);
  const [desk, setDesk] = useState(null);
  useEffect(() => { getJson(`/api/app/desk${q()}`).then(setDesk); }, [config && config.project ? config.project.root : '']); // eslint-disable-line react-hooks/exhaustive-deps
  const rungs = [
    ['installed', config && config.tldrawVersion ? { ok: true, words: `the tldraw SDK ${config.tldrawVersion}, bundled with this app (${config.built ? 'built' : 'not built'}). Installed is not working.` } : { ok: false, words: 'not read' }],
    ['signed in', config ? (config.licenseKey ? { ok: true, words: `a licence key is set on the companion (tldraw checks it in the page)${lic ? `; the SDK’s own readout: ${lic.state} — ${lic.words}` : '; open the Canvas for the SDK’s own readout'}` } : { ok: false, words: 'no licence key is set: the Canvas runs and says it is unlicensed, in the SDK’s words' }) : { ok: false, words: 'not read' }],
    ['discovered', desk ? (desk.ok ? { ok: true, words: `the Canvas desk of ${desk.project}` } : { ok: false, words: desk.error || 'not read' }) : { ok: false, words: 'reading…' }],
    ['ran here', desk && desk.ok && desk.revision ? { ok: true, words: `saved at revision ${desk.revision}`, at: desk.savedAt } : { ok: false, words: 'the desk has not been saved in this project yet' }],
    ['qualified', { ok: false, words: 'not claimed: no qualification of the Canvas has been run in this build' }],
  ];
  return (
    <article className="tx-int-card" data-connector="tldraw" aria-label="tldraw · the Canvas">
      <header className="tx-int-head"><h3 className="tx-int-title">tldraw · the Canvas</h3><span className="ta-muted">the desk is kept in Timmy’s project storage</span></header>
      <Ladder rungs={rungs} />
      <p className="tx-int-next"><span className="ta-context-k">NEXT</span> {picked && picked.answer ? `Put operation ${picked.id}’s result on the Canvas: a note with its words, operation and receipt.` : 'Choose a finished Treg operation to put its result on the Canvas as a note.'}</p>
      <div className="ta-row">
        <Button kind="primary" disabled={!picked || !picked.answer || picked.live} onClick={() => placeOnCanvas(noteOf(picked), picked.id)} data-action="tldraw-place">Put the result on the Canvas</Button>
      </div>
      <p className="ta-muted">The note carries the host operation’s own result: nothing is called again to make it.</p>
    </article>
  );
}

export function Integrations() {
  const config = useApp((s) => s.config);
  const [data, setData] = useState(null);
  const [picked, setPicked] = useState(null);
  const timer = useRef(null);
  const load = async () => { const r = await getJson(`/api/connectors${q()}`); setData(r); return r; };
  useEffect(() => { load(); }, [config && config.project ? config.project.root : '']); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useMemo(() => (data && Array.isArray(data.ops) ? data.ops.some((o) => o.live) : false), [data]);
  useEffect(() => {
    if (!live) return undefined;
    timer.current = setInterval(load, 1500);
    return () => clearInterval(timer.current);
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const op = data && Array.isArray(data.ops) ? data.ops.find((o) => o.id === picked) || null : null;
  return (
    <div className="tx-int-grid">
      <TregCard data={data} reload={load} picked={picked} setPicked={setPicked} />
      <TldrawCard picked={op} />
    </div>
  );
}
