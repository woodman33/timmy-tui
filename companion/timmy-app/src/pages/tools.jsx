// R12 (the finish brief): Tools & integrations — what Timmy can use, in the inventory's three words kept apart (available: the
// files are here · configured: the key, setting or address is set · exercised: a receipt of a real run exists; installed is
// not working, AGENTS.md §8), and the MCP inspector: list a server's tools through one of the two routes, check the arguments
// against the schema the listing gave, and call — through POST /api/panel/tools/call, which refuses before anything runs when
// the call waits for you (409, with the line for Timmy's terminal), when the tool is not on the list (404) or when the
// arguments fail its schema (422). Green only for what this page observed just now: a listing that answered, a call whose
// receipt verified. Every word comes from the companion's answers (src/companion/panels/tools.ts).
import { useEffect, useMemo, useState } from 'react';
import { getJson, postJson } from '../api.js';
import { Page, Panel } from '../shell.jsx';
import { goTo, projectQuery, useApp } from '../store.js';
import { Button, Empty, Facts, StateWord, clock, day } from '../ui.jsx';
import { ConfigureRow, isConfigured, readInventory, useInventory } from '../configure.jsx';
import { Integrations } from './integrations.jsx';
import './tools.css';

const base = '/api/panel/tools';
const q = (extra = '') => { const p = projectQuery('').trim(); const all = [extra, p].filter(Boolean).join('&'); return all ? `?${all}` : ''; };
const ms = (n) => (typeof n === 'number' ? (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`) : '');
const SPEC = (s) => (s.kind === 'fixture' ? { kind: 'fixture' } : { kind: 'configured', name: s.name });
const keyOfServer = (s) => (s.kind === 'fixture' ? 'fixture' : `configured:${s.name}`);

/** Arguments to start from: each property's default, or an empty value of its type for a required one. */
function startArgs(tool) {
  const props = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
  const req = (tool && tool.required) || [];
  const out = {};
  for (const [k, s] of Object.entries(props)) {
    if (s && s.default !== undefined) out[k] = s.default;
    else if (req.includes(k)) out[k] = s && (s.type === 'number' || s.type === 'integer') ? 0 : s && s.type === 'boolean' ? false : s && Array.isArray(s.enum) ? s.enum[0] : '';
  }
  return JSON.stringify(out, null, 2);
}

function Inventory({ inv, group, setGroup, picked, pick }) {
  if (!inv) return <Empty>Reading what is on this computer…</Empty>;
  if (!inv.ok) return <Empty>{inv.error || 'The companion did not answer the inventory.'}</Empty>;
  const rows = inv.inventory && Array.isArray(inv.inventory.rows) ? inv.inventory.rows : [];
  const groups = inv.inventory && Array.isArray(inv.inventory.groups) ? inv.inventory.groups : [];
  const cards = new Map((inv.cards || []).map((c) => [c.id, c]));
  const shown = rows.filter((r) => r.group === group);
  return (
    <>
      <div className="ta-seg tx-tools-groups" role="tablist" aria-label="Kinds of capability">
        {groups.map((g) => <button key={g} type="button" role="tab" aria-selected={g === group} onClick={() => setGroup(g)}>{g} <span className="tx-tools-n">{rows.filter((r) => r.group === g).length}</span></button>)}
      </div>
      <ul className="ta-cfg-list" aria-label={`${group}: configured or not`}>
        {shown.map((r) => <ConfigureRow key={r.id} row={r} card={cards.get(r.id)} onPick={() => pick(r.id)} picked={picked === r.id} />)}
      </ul>
      <p className="ta-muted">{inv.read}. {inv.note}</p>
    </>
  );
}

function RowFacts({ row, card }) {
  const word = (w, name) => (w ? <span><StateWord word={w.ok ? name : `not ${name}`} /> {w.found}</span> : null);
  return (
    <>
      <p className="tx-tools-title">{row.name}</p>
      <p className="ta-muted">{row.group} · {row.id}</p>
      <Facts rows={[
        ['available', word(row.available, 'available')],
        ['configured', word(row.configured, 'configured')],
        ['exercised', row.exercised ? <span><StateWord word={row.exercised.ok ? 'exercised' : 'not exercised'} /> {row.exercised.ok && row.exercised.what ? row.exercised.what : row.exercised.found}{row.exercised.receipt ? <> · receipt <code>{row.exercised.receipt}</code></> : null}{row.exercised.when ? ` · ${day(row.exercised.when)}` : ''}</span> : null],
        ['next', card && card.step ? <span>{card.step.next}{card.step.where ? ` (${card.step.where})` : ''}</span> : row.next || null],
      ]} />
      {card && card.step && card.step.where === 'Models & accounts' ? <Button onClick={() => goTo('models')}>Models &amp; accounts →</Button> : null}
      <details className="ta-details"><summary>Where each word was read</summary>
        <Facts rows={[['available', row.available && row.available.source], ['configured', row.configured && row.configured.source], ['exercised', row.exercised && row.exercised.source]]} />
      </details>
      <p className="ta-muted">Available means the files are here; configured means its key, setting or address is set; exercised means a receipt of a real run exists. None of the three is a check that it works now.</p>
    </>
  );
}

function CallFacts({ call }) {
  const items = call.answer && Array.isArray(call.answer.items) ? call.answer.items : [];
  return (
    <>
      <p className="tx-tools-title">{call.tool} <span className="ta-muted">· {call.route}</span></p>
      <Facts rows={[
        ['outcome', <StateWord key="o" word={call.outcome} live={call.outcome === 'answered' && !call.isError && !!(call.receipt && call.receipt.verified)} />],
        ['server', call.server],
        ['started', day(call.startedAt)],
        ['took', ms(call.ms)],
        ['receipt', call.receipt ? <span key="r"><span className={call.receipt.verified ? 'ta-verified' : 'ta-unverified'}>{call.receipt.verified ? '✓ verified' : '✕ not verified'}</span> <code>{call.receipt.id}</code></span> : 'none'],
        ['record', call.record ? <code key="c">{call.record}</code> : null],
      ]} />
      {items.length ? (
        <div className="tx-tools-answer">
          <p className="ta-context-k">THE ANSWER{call.answer.from ? ` · from the ${call.answer.from}` : ''}</p>
          {items.map((it, i) => (it.type === 'text' ? <pre key={i} className="tx-tools-pre">{String(it.text).slice(0, 4000)}</pre>
            : <p key={i} className="ta-muted">An item of type {it.type}{it.mimeType ? ` (${it.mimeType})` : ''}: kept with the call’s record, not drawn here.</p>))}
        </div>
      ) : null}
      {(call.notes || []).length ? <ul className="tx-tools-notes">{call.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
    </>
  );
}

function Inspector({ state, servers, onCall }) {
  const pool = useMemo(() => {
    const out = [];
    if (state && state.fixture && state.fixture.ok) out.push({ kind: 'fixture', label: state.fixture.label });
    for (const s of (servers && servers.servers) || []) out.push({ kind: 'configured', name: s.name, label: `${s.name}${s.transport ? ` · ${s.transport}` : ''}${s.importKind ? ` · from ${s.importKind}` : s.source ? ` · ${s.source}` : ''}${s.auth ? ` · sign-in ${s.auth} (configured, not checked)` : ''}` });
    return out;
  }, [state, servers]);
  const [server, setServer] = useState(0);
  const [route, setRoute] = useState('sdk');
  const [listing, setListing] = useState(null);
  const [busy, setBusy] = useState('');
  const [tool, setTool] = useState(null);
  const [args, setArgs] = useState('{}');
  const [check, setCheck] = useState(null);
  const [result, setResult] = useState(null);
  const s = pool[server] || null;
  const routes = state && Array.isArray(state.routes) ? state.routes : [];
  const list = async () => {
    if (!s) return;
    setBusy('list'); setTool(null); setCheck(null); setResult(null);
    const r = await postJson(`${base}/list${q()}`, { server: SPEC(s), route });
    setBusy('');
    setListing({ ...r, key: keyOfServer(s) });
    if (r.ok && Array.isArray(r.tools) && r.tools.length) pickTool(r.tools[0]);
  };
  const pickTool = (t) => { setTool(t); setArgs(startArgs(t)); setCheck(null); setResult(null); };
  const parsed = (() => { try { const v = JSON.parse(args || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } })();
  const doCheck = async () => {
    if (!tool || !parsed) return;
    setBusy('check');
    const r = await postJson(`${base}/check${q()}`, { server: SPEC(s), route, tool: tool.name, args: parsed, inputSchema: tool.inputSchema, annotations: tool.annotations });
    setBusy('');
    setCheck(r);
  };
  const doCall = async () => {
    if (!tool || !parsed) return;
    setBusy('call');
    const r = await postJson(`${base}/call${q()}`, { server: SPEC(s), route, tool: tool.name, args: parsed });
    setBusy('');
    setResult(r);
    if (r.status === 200 && r.call) onCall(r.call);
  };
  const L = listing && s && listing.key === keyOfServer(s) ? listing : null;
  return (
    <div className="tx-tools-inspector">
      <div className="tx-tools-controls">
        <label className="tx-tools-field">Server
          <select value={server} onChange={(e) => { setServer(Number(e.target.value)); setListing(null); setTool(null); setResult(null); }} disabled={!pool.length}>
            {pool.length ? pool.map((p, i) => <option key={keyOfServer(p)} value={i}>{p.kind === 'fixture' ? 'FAKE fixture (Timmy’s test server)' : p.label}</option>) : <option>none</option>}
          </select>
        </label>
        <div className="tx-tools-field">Route
          <div className="ta-seg" role="radiogroup" aria-label="Through which route">
            {routes.map((r) => <button key={r.id} type="button" role="radio" aria-checked={route === r.id} aria-pressed={route === r.id} onClick={() => setRoute(r.id)} title={r.details}>{r.id === 'sdk' ? 'SDK' : 'MCPorter'}</button>)}
          </div>
        </div>
        <Button kind="primary" onClick={list} disabled={!s || !!busy}>{busy === 'list' ? 'Listing…' : 'List its tools'}</Button>
      </div>
      {s && s.kind === 'fixture' ? <p className="ta-muted">{s.label}</p> : null}
      {!pool.length ? <Empty>No server to list: Timmy’s FAKE fixture is not here, and MCPorter’s config names none.</Empty> : null}
      {L ? (L.ok ? (
        <>
          <p className="ta-line"><StateWord word="listed just now" live /> <span className="ta-muted">{L.tools.length} tools through {L.route} · {ms(L.ms)} · {clock(L.at)}. {L.started}</span></p>
          <div className="tx-tools-toollist" role="listbox" aria-label="Its tools">
            {L.tools.map((t) => (
              <button key={t.name} type="button" role="option" aria-selected={!!tool && tool.name === t.name} className="tx-tools-tool" onClick={() => pickTool(t)}>
                <span><strong>{t.name}</strong> <span className="ta-muted">({(t.params || []).map((p) => ((t.required || []).includes(p) ? p : `${p}?`)).join(', ')})</span></span>
                <span className="tx-tools-hint">{t.hints}{t.annotations ? ' (its claim, not checked)' : ''}</span>
              </button>
            ))}
          </div>
          <p className="ta-muted">Hints: {L.hintsNote}.</p>
        </>
      ) : L.status === 409 ? (
        <p className="ta-result">NEEDS YOU: {L.error || L.words || 'this server is not started from this page.'} {(L.lines || []).length ? <code>{L.lines.join(' ')}</code> : null}</p>
      ) : <p className="ta-result">tools/list through {route}: {L.error || `the companion answered ${L.status}`}</p>) : null}
      {tool ? (
        <div className="tx-tools-call">
          <p className="tx-tools-title">{tool.name}</p>
          {tool.description ? <p className="ta-muted">{tool.description}</p> : null}
          <label className="tx-tools-field">Arguments (JSON)
            <textarea className="tx-tools-args" rows={Math.min(10, Math.max(3, args.split('\n').length))} value={args} onChange={(e) => { setArgs(e.target.value); setCheck(null); }} spellCheck={false} aria-invalid={!parsed} />
          </label>
          {!parsed ? <p className="ta-result">The arguments are not a JSON object.</p> : null}
          <div className="ta-row">
            <Button onClick={doCheck} disabled={!parsed || !!busy}>{busy === 'check' ? 'Checking…' : 'Check the arguments'}</Button>
            <Button kind="primary" onClick={doCall} disabled={!parsed || !!busy}>{busy === 'call' ? 'Calling…' : 'Call'}</Button>
          </div>
          {check ? (
            <div className="tx-tools-check">
              <p className="ta-line">{check.valid ? <StateWord word="arguments pass its schema" live /> : <StateWord word="not checked" />} <span className="ta-muted">{(check.errors || []).map((e) => `${e.field}: ${e.message}`).join(' · ') || check.error}</span></p>
              {check.rule ? <p className="ta-muted">{check.rule.runs ? 'Runs from this page: ' : 'Waits for you: '}{check.rule.why}</p> : check.ruleFrom ? <p className="ta-muted">{check.ruleFrom}</p> : null}
              {check.request ? <details className="ta-details"><summary>The request</summary><pre className="tx-tools-pre">{check.request}</pre></details> : null}
            </div>
          ) : null}
          {result ? (
            result.status === 200 ? <p className="ta-line"><StateWord word={result.call.outcome} live={result.call.outcome === 'answered' && !result.call.isError && !!(result.call.receipt && result.call.receipt.verified)} /> <span className="ta-muted">{result.rule ? `${result.rule.why}.` : ''} The call and its answer are in the context column.</span></p>
              : result.status === 409 ? <div className="ta-result"><strong>NEEDS YOU</strong> — not called from this page: {result.rule ? `${result.rule.why}.` : result.error || ''}{result.cli && result.cli.repl && result.cli.repl[route] ? <> Type it in Timmy’s terminal, where a typed /mcp call is your own command: <code className="tx-tools-cmd">{result.cli.repl[route]}</code></> : null}</div>
                : result.status === 422 ? <p className="ta-result">Not called: the arguments fail its schema. {(result.errors || []).map((e) => `${e.field}: ${e.message}`).join(' · ')}</p>
                  : <p className="ta-result">Not called: {result.error || `the companion answered ${result.status}`}.</p>
          ) : null}
        </div>
      ) : null}
      {state && state.rule ? <details className="ta-details"><summary>The page’s rule for a call</summary><p className="ta-muted">{state.rule}</p></details> : null}
    </div>
  );
}

/** The Timmy MCP page: what `timmy mcp serve` declares, read from this Timmy's code (GET /api/panel/tools/timmy-mcp). */
function TimmyMcp({ picked, pick }) {
  const [r, setR] = useState(null);
  const [f, setF] = useState('');
  useEffect(() => { getJson(`${base}/timmy-mcp${q()}`).then(setR); }, []);
  if (!r) return <Empty>Reading what Timmy serves…</Empty>;
  if (!r.ok) return <Empty>{r.error || 'The companion did not answer.'}</Empty>;
  const tools = (r.tools || []).filter((t) => !f || `${t.name} ${t.description}`.toLowerCase().includes(f.toLowerCase()));
  return (
    <>
      <p className="ta-muted">Start it for another agent or editor with <code>{r.serve}</code> ({r.transport}). {r.read}.</p>
      <label className="tx-tools-filter"><span className="tr-visually-hidden">Find a tool</span><input type="search" value={f} onChange={(e) => setF(e.target.value)} placeholder={`Find among ${(r.tools || []).length} tools`} /></label>
      <table className="ta-table">
        <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
        <tbody>
          {tools.map((t) => (
            <tr key={t.name} aria-selected={picked === t.name}>
              <td><button type="button" className="tx-tools-name" onClick={() => pick(t.name)}>{t.name}</button></td>
              <td className="ta-muted">{t.description.length > 140 ? `${t.description.slice(0, 140)}…` : t.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** One page for three rail entries: Integrations (view 'integrations', page tools), MCP → CLI (view 'mcp', page mcp-cli), Timmy MCP (view 'timmy', page timmy-mcp). */
export default function ToolsPage({ view = 'integrations' }) {
  const [timmyTool, setTimmyTool] = useState(null);
  const config = useApp((s) => s.config);
  const inv = useInventory();
  const [state, setState] = useState(null);
  const [servers, setServers] = useState(null);
  const [calls, setCalls] = useState(null);
  const [group, setGroup] = useState('Tools');
  const [picked, setPicked] = useState(null);
  const [call, setCall] = useState(null);
  const loadInv = (refresh) => readInventory(refresh);
  const loadCalls = async () => setCalls(await getJson(`${base}/calls${q()}`));
  useEffect(() => {
    getJson(`${base}/state${q()}`).then(setState);
    getJson(`${base}/servers${q()}`).then(setServers);
    loadCalls();
  }, [config && config.project ? config.project.root : '']); // eslint-disable-line react-hooks/exhaustive-deps
  const openCall = async (id) => { setPicked(null); const r = await getJson(`${base}/call/${encodeURIComponent(id)}${q()}`); setCall(r.ok ? r.call : { tool: id, outcome: r.error || 'not read', notes: [] }); };
  const rows = inv && inv.inventory ? inv.inventory.rows || [] : [];
  const row = rows.find((r) => r.id === picked);
  const card = inv && inv.cards ? inv.cards.find((c) => c.id === picked) : null;
  const callRows = calls && Array.isArray(calls.calls) ? calls.calls : [];
  const routes = state && Array.isArray(state.routes) ? state.routes : [];
  const context = row ? <RowFacts row={row} card={card} />
    : call ? <CallFacts call={call} />
      : (
        <>
          <p className="tx-tools-title">Nothing selected</p>
          <p className="ta-muted">Select a capability’s name to see its three facts (available, configured, exercised) and where each was read, or a call to see its answer and receipt.</p>
          {routes.length ? (
            <>
              <p className="ta-context-k">THE TWO MCP ROUTES</p>
              <Facts rows={routes.map((r) => [r.id === 'sdk' ? 'SDK' : 'MCPorter', <span key={r.id}><StateWord word={r.rung} /> {r.version ? `v${r.version}` : ''} <span className="ta-muted">· {r.reaches}</span></span>])} />
              <p className="ta-muted">Installed is not working: a route counts as reached only when a listing through it answers on this page.</p>
            </>
          ) : null}
        </>
      );
  const pageId = view === 'mcp' ? 'mcp-cli' : view === 'timmy' ? 'timmy-mcp' : 'tools';
  const configuredBand = ['CONFIGURED', inv && inv.ok && inv.inventory ? <>{(inv.inventory.rows || []).filter(isConfigured).length} of {(inv.inventory.rows || []).length} <span className="ta-muted">· {inv.counts ? `${inv.counts.exercised} run here` : ''}</span></> : <span className="ta-muted">reading…</span>];
  const serversBand = ['MCP SERVERS', servers ? (servers.ok ? <>{(servers.servers || []).length} configured <span className="ta-muted">· none started</span></> : <span className="ta-muted">{servers.error || 'not read'}</span>) : <span className="ta-muted">reading…</span>];
  const callsBand = ['CALLS', calls ? (callRows.length ? <>{callRows.length}{calls.more ? `+${calls.more}` : ''} <span className="ta-muted">· last {callRows[0].tool} {clock(callRows[0].startedAt)}</span></> : <span className="ta-muted">none from this project yet</span>) : <span className="ta-muted">reading…</span>];
  if (view === 'timmy') {
    return (
      <Page id={pageId} band={[serversBand, callsBand]}
        context={timmyTool ? <><p className="tx-tools-title">{timmyTool}</p><p className="ta-muted">Declared by <code>timmy mcp serve</code>. Call it from another agent, or list Timmy’s server live from MCP → CLI once it is configured there.</p><button type="button" className="ta-link" onClick={() => goTo('mcp-cli')}>Open MCP → CLI →</button></> : <p className="ta-muted">Select a tool to see where it is called from.</p>}>
        <Panel id="timmy-mcp" kicker="TIMMY’S OWN SERVER" title="The tools Timmy serves over MCP">
          <TimmyMcp picked={timmyTool} pick={setTimmyTool} />
        </Panel>
      </Page>
    );
  }
  if (view === 'mcp') {
    return (
      <Page id={pageId} band={[serversBand, callsBand]} context={context}>
        <Panel id="inspector" kicker="MCP → CLI" title="List, check and call a server’s tools">
          {state ? (state.ok === false ? <Empty>{state.error}</Empty> : <Inspector state={state} servers={servers} onCall={(c) => { setCall(c); setPicked(null); loadCalls(); loadInv(true); }} />) : <Empty>Reading the routes…</Empty>}
        </Panel>
        <Panel id="calls" kicker="RECORDS" title="This project’s MCP calls" tools={<Button onClick={loadCalls}>Read again</Button>}>
          {!calls ? <Empty>Reading…</Empty> : !callRows.length ? <Empty>No MCP call was made in this project yet.</Empty> : (
            <table className="ta-table">
              <thead><tr><th>When</th><th>Tool</th><th>Route</th><th>Outcome</th><th>Receipt</th></tr></thead>
              <tbody>
                {callRows.map((c) => (
                  <tr key={c.id} aria-selected={!!call && call.id === c.id}>
                    <td>{day(c.startedAt)}</td>
                    <td><button type="button" className="tx-tools-name" onClick={() => openCall(c.id)}>{c.tool}</button></td>
                    <td>{c.route}</td>
                    <td><StateWord word={c.outcome} /></td>
                    <td>{c.receipt ? <><span className={c.receipt.verified ? 'ta-verified' : 'ta-unverified'}>{c.receipt.verified ? '✓' : '✕'}</span> <code>{c.receipt.id}</code></> : <span className="ta-muted">none</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </Page>
    );
  }
  return (
    <Page id={pageId}
      actions={<Button onClick={() => loadInv(true)}>Read this computer again</Button>}
      band={[configuredBand, serversBand]}
      context={context}>
      <Panel id="integrations" kicker="INTEGRATIONS" title="Treg and the Canvas: installed, signed in, discovered, ran here, qualified">
        <Integrations />
      </Panel>
      <Panel id="inventory" kicker="WHAT TIMMY CAN USE" title="Capabilities on this computer">
        <Inventory inv={inv} group={group} setGroup={setGroup} picked={picked} pick={(id) => { setCall(null); setPicked(id); }} />
      </Panel>
    </Page>
  );
}
