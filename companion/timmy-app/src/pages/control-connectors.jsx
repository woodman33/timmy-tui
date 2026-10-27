// The 07:37 completion pass, gap I6 (the Control Room handoff 2a798e1f, IMPLEMENTATION-SLICE.md): the Control Room's
// connector-call cards. A projection of the connector operations Timmy already keeps (src/companion/connector-ops.ts: the
// job, act's operation record, the /mcp call record and the connector.call receipt), read from GET /api/connectors; Stop and
// Recover are the same routes the Integrations page uses. No new engine and no new store. Each card keeps three facts apart:
// the process (running, stopping, ended), the work's outcome (Treg's answer or its error), and its check (the sealed receipt).
// A charge Treg does not state is unknown, never $0; a Stop after a request was sent does not withdraw it.
import { useEffect, useRef, useState } from 'react';
import { getJson, postJson } from '../api.js';
import { Panel } from '../shell.jsx';
import { goTo, projectQuery } from '../store.js';
import { Button, Empty, Facts, StateWord, clock, day } from '../ui.jsx';

const EVERY_MS = 4000;
const usd = (n) => (typeof n === 'number' && Number.isFinite(n) ? `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}` : null);

/** The charge, in words that never turn unknown into zero. */
export function chargeWords(op) {
  if (!op.paid) return 'none: not a paid call';
  if (op.live) return 'not known yet: the call is still running';
  if (op.charged && typeof op.charged.usd === 'number') return `${usd(op.charged.usd)} (Treg’s ${op.charged.field})`;
  return 'unknown: Treg’s answer states no charge (check Treg’s history)';
}

/** The process, the outcome and the check, apart. */
export function threeFacts(op) {
  const process = op.live ? (op.state === 'stopping' ? 'stopping' : 'running') : 'ended';
  const outcome = op.live ? 'not yet' : op.state === 'answered' ? (op.mcp && op.mcp.isError ? 'the tool answered with an error' : 'answered')
    : op.state === 'stopped' ? (op.stop && op.stop.in_flight ? 'stopped after the request was sent (not withdrawn)' : 'stopped before anything was sent')
      : op.state === 'interrupted' ? 'interrupted: Recover settles it' : op.state === 'unknown' ? 'unknown: whether Treg charged is not known' : op.state;
  const check = op.receipt ? `receipt ${op.receipt}` : op.live ? 'not sealed yet' : 'no receipt';
  return { process, outcome, check };
}

function OpCard({ op, onChange }) {
  const [note, setNote] = useState('');
  const act = async (what) => {
    setNote('');
    const r = await postJson(`/api/connectors/ops/${op.id}/${what}${projectQuery()}`, {});
    if (!r.ok) setNote(r.error || `The companion answered ${r.status}.`);
    onChange();
  };
  const f = threeFacts(op);
  const q = op.approved ? op.approved.quote : op.quote || null;
  return (
    <article className="tx-ctl-run" data-connector-op={op.id} aria-label={`${op.connector} ${op.tool || op.kind}`}>
      <header className="tx-ctl-run-head">
        <p className="tx-ctl-run-title">Treg · {op.tool || 'discover'} {op.paid ? <span className="ta-muted">· paid</span> : null}</p>
        <StateWord word={op.state} live={op.live} />
      </header>
      <Facts rows={[
        ['process', f.process],
        ['outcome', f.outcome],
        ['check', f.check],
        ['quote', q ? `${usd(q.usd) || 'unknown'} ${q.type || ''}${q.checked ? ` · checked ${q.checked}` : ''}` : 'none: no price preview for this call'],
        ['charge', chargeWords(op)],
        ['started', `${day(op.started_at)} ${clock(op.started_at)}${op.ended_at ? ` · ended ${clock(op.ended_at)}` : ''}`],
      ]} />
      <p className="ta-muted">{op.next}</p>
      <div className="ta-row">
        {op.live ? <Button onClick={() => act('stop')}>Stop</Button> : null}
        {op.state === 'interrupted' ? <Button onClick={() => act('recover')}>Recover</Button> : null}
      </div>
      {note ? <p className="ta-result" role="status">{note}</p> : null}
      <details className="ta-details">
        <summary>Identity and records</summary>
        <Facts rows={[
          ['operation', op.id],
          ['act operation', op.operation || 'none'],
          ['MCP call', op.mcp ? `${op.mcp.id} · ${op.mcp.outcome} · ${op.mcp.ms} ms` : 'none'],
          ['route', op.route],
          ['read from', `GET /api/connectors/ops/${op.id}`],
        ]} />
      </details>
    </article>
  );
}

export function ConnectorCalls() {
  const [s, setS] = useState(null);
  const alive = useRef(true);
  const read = async () => { const r = await getJson(`/api/connectors${projectQuery()}`); if (alive.current) setS(r); };
  useEffect(() => { alive.current = true; read(); return () => { alive.current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!s || !s.ok || !(s.ops || []).some((o) => o.live)) return undefined;
    const t = setTimeout(read, EVERY_MS);
    return () => clearTimeout(t);
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const ops = s && s.ok ? s.ops || [] : [];
  return (
    <Panel id="connector-calls" kicker="CONNECTOR CALLS" title="Treg calls: the process, the outcome and the check, apart"
      tools={<Button onClick={read}>Read again</Button>}>
      {!s ? <Empty>Reading the connector calls…</Empty> : !s.ok ? <p className="ta-result" role="status">{s.error || 'The companion did not answer.'}</p>
        : !ops.length ? <Empty>No connector call in this project yet. Start one from <button type="button" className="ta-link" onClick={() => goTo('tools')}>Integrations</button>.</Empty>
          : <div className="tx-ctl-runs">{ops.map((o) => <OpCard key={o.id} op={o} onChange={read} />)}</div>}
    </Panel>
  );
}
