// R12 (the finish brief): Runs & receipts — what ran in this project, with proof. The companion's list of the project's runs
// (GET /api/panel/runs/list: every surface's sealed chat turns, the job store's jobs, the other sealed receipts, newest first,
// each receipt verified against the runs chain read for that answer) beside this conversation's own sealed answers (the Chat's
// view, GET /api/chat/view). The selected row's facts and its receipt are in the context column: ✓ (green) only for a receipt
// the companion verified. Nothing here runs, stops or re-seals anything.
import { useEffect, useMemo, useState } from 'react';
import { getJson } from '../api.js';
import { Page, Panel, Tool } from '../shell.jsx';
import { goTo, projectQuery, useApp } from '../store.js';
import { Button, Empty, Facts, StateWord, clock, day } from '../ui.jsx';
import './runs.css';

const KINDS = [['all', 'All'], ['turn', 'Chat turns'], ['job', 'Jobs'], ['receipt', 'Other receipts']];
const KIND_WORDS = { turn: 'chat turn', job: 'job', receipt: 'receipt' };
/** An answer's words on one line, without the markdown's marks (the Chat draws the markdown itself). */
const plain = (text) => String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
const secs = (ms) => (typeof ms === 'number' ? (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`) : null);

function Receipt({ r }) {
  if (!r) return <span className="ta-muted">none sealed</span>;
  return <span className="tx-runs-receipt"><span className={r.verified ? 'ta-verified' : 'ta-unverified'}>{r.verified ? '✓' : '✕'}</span> <code>{r.short}</code></span>;
}

/** The runs list, read once on open and again on Read again (and every few seconds while something runs). */
function useRuns() {
  const [answer, setAnswer] = useState(null);
  const [asking, setAsking] = useState(false);
  const read = async () => {
    setAsking(true);
    const r = await getJson(`/api/panel/runs/list${projectQuery()}`);
    setAnswer({ ...r, readAt: new Date().toISOString() });
    setAsking(false);
    return r;
  };
  useEffect(() => { read(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!answer || !answer.ok || !answer.running) return undefined;
    const t = setTimeout(() => { if (document.visibilityState === 'visible') read(); }, 4000);
    return () => clearTimeout(t);
  }, [answer]); // eslint-disable-line react-hooks/exhaustive-deps
  return { answer, asking, read };
}

function Detail({ sel, here }) {
  if (!sel) return <p className="ta-muted">Select a run or an answer to see its facts and its receipt.</p>;
  if (sel.from === 'conversation') {
    const t = sel.row;
    const r = t.receipt;
    return (
      <div className="tx-runs-detail">
        <p className="tx-runs-detail-title">Answer in this conversation</p>
        <Facts rows={[
          ['when', day(t.at)],
          ['model', t.model || 'not recorded'],
          ['where', r ? r.where : null],
          ['took', r ? secs(r.ms) : null],
          ['stopped', t.stopped ? `yes${t.stopped.by ? `, by ${t.stopped.by}` : ''}` : null],
        ]} />
        <ReceiptFacts id={r ? r.id : null} verified={r ? r.verified === true : false} why={null} hash={null} />
        {t.text ? <p className="tx-runs-quote">{plain(t.text).slice(0, 400)}{plain(t.text).length > 400 ? '…' : ''}</p> : null}
      </div>
    );
  }
  const row = sel.row;
  return (
    <div className="tx-runs-detail">
      <p className="tx-runs-detail-title">{row.mark} {row.line}</p>
      <Facts rows={[
        ['kind', KIND_WORDS[row.kind] || row.kind],
        ['state', <StateWord key="s" word={row.state} live={false} />],
        ['when', day(row.at)],
        ['model', row.kind === 'job' ? (row.model || 'asked no model') : (row.model || 'not recorded')],
        ['took', row.state === 'running' ? 'still running' : secs(row.ms) || 'not recorded'],
        ['sent from', row.turn ? row.turn.from : null],
        ['turn', row.turn && row.turn.id ? <code key="t">{row.turn.id}</code> : null],
        ['job', row.job ? <span key="j"><code>{row.job.id}</code>{row.job.blocks ? ` · ${row.job.blocks}` : ''}</span> : null],
        ['operation', row.operation ? <code key="o">{row.operation}</code> : null],
        ['this chat', here ? 'an answer of the conversation on the Chat' : null],
      ]} />
      <ReceiptFacts id={row.receipt ? row.receipt.short : null} verified={row.receipt ? row.receipt.verified : false} why={row.receipt ? row.receipt.why : null} hash={row.receipt ? row.receipt.hash : null} />
    </div>
  );
}

function ReceiptFacts({ id, verified, why, hash }) {
  return (
    <div className="tx-runs-seal" data-verified={id ? String(verified) : 'none'}>
      <p className="ta-context-k">RECEIPT</p>
      {!id ? <p className="ta-muted">No receipt was sealed for this.</p> : (
        <>
          <p className="tx-runs-seal-line">
            {verified ? <span className="ta-verified">✓ verified</span> : <span className="ta-unverified">✕ not verified</span>} <code>{id}</code>
          </p>
          {hash ? <p className="tx-runs-hash"><code>{hash}</code></p> : null}
          <p className="ta-muted">{verified ? 'Checked by the companion against the project’s runs chain in this reading (its link, body hash and signature).' : why ? `The companion’s check: ${why}` : 'Not verified in this reading.'}</p>
        </>
      )}
    </div>
  );
}

export default function RunsPage() {
  const view = useApp((s) => s.view);
  const viewAt = useApp((s) => s.viewAt);
  const { answer, asking, read } = useRuns();
  const [kind, setKind] = useState('all');
  const [sel, setSel] = useState(null);
  const turns = view && view.conversation && Array.isArray(view.conversation.turns) ? view.conversation.turns : [];
  const answers = useMemo(() => turns.filter((t) => t.kind === 'timmy').slice(-40).reverse(), [turns]);
  const hereIds = useMemo(() => new Set(answers.filter((t) => t.receipt).map((t) => t.receipt.id)), [answers]);
  const ok = answer && answer.ok;
  const rows = ok && Array.isArray(answer.rows) ? answer.rows : [];
  const shown = kind === 'all' ? rows : rows.filter((r) => r.kind === kind);
  const sealed = rows.filter((r) => r.receipt);
  const verified = sealed.filter((r) => r.receipt.verified);
  const notes = ok && Array.isArray(answer.notes) ? answer.notes : [];
  const keyOf = (r) => `${r.kind}:${r.id}:${r.at}`;
  const running = ok ? answer.running : 0;
  const actions = running ? <Button kind="primary" onClick={() => goTo('control')}>See what runs now</Button>
    : ok && !rows.length && !answers.length ? <Button kind="primary" onClick={() => goTo('chat')}>Start in Chat</Button>
      : <Button onClick={read} disabled={asking}>{asking ? 'Reading…' : 'Read again'}</Button>;
  return (
    <Page id="runs"
      actions={actions}
      band={[
        ['LISTED', !answer ? <span className="ta-muted">reading…</span> : ok ? <>{rows.length}{answer.total > rows.length ? <span className="ta-muted"> of {answer.total}</span> : null}</> : <span className="ta-muted">not read</span>],
        ['RUNNING', ok ? (running ? <StateWord word={`${running} running`} /> : <span className="ta-muted">nothing</span>) : <span className="ta-muted">—</span>],
        ['SEALED', ok ? <>{sealed.length} <span className="ta-muted">· {verified.length} verified</span></> : <span className="ta-muted">—</span>],
        ['THIS CONVERSATION', view ? <>{answers.length} answer{answers.length === 1 ? '' : 's'} <span className="ta-muted">· {answers.filter((t) => t.receipt && t.receipt.verified).length} verified</span></> : <span className="ta-muted">reading…</span>],
      ]}
      context={<Detail sel={sel} here={sel && sel.from === 'runs' && sel.row.receipt ? hereIds.has(sel.row.receipt.short) : false} />}
      tools={<>
        <span className="ta-toolsrow-k">SHOW</span>
        {KINDS.map(([id, label]) => <Tool key={id} label={label} pressed={kind === id} onClick={() => setKind(id)} />)}
        <span className="ta-toolsrow-sep" aria-hidden="true" />
        <Tool glyph="↻" label={asking ? 'Reading…' : 'Read again'} onClick={asking ? null : read} />
        <Tool glyph="⎙" label="Export receipts" why="not in this build" />
      </>}>
      <Panel id="runs" kicker="THE PROJECT" title="Runs and receipts"
        tools={ok ? <span className="ta-muted">read {clock(answer.readAt)}</span> : null}>
        {!answer ? <Empty>Reading the project’s runs…</Empty>
          : !ok ? <p className="ta-result" role="status">{answer.error || `The companion answered ${answer.status || 'nothing'}.`}</p>
            : !shown.length ? <Empty>{rows.length ? `No ${KINDS.find((k) => k[0] === kind)[1].toLowerCase()} in this list.` : 'Nothing has run in this project yet: no sealed turn, no job, no receipt.'}</Empty>
              : (
                <div className="tx-runs-scroll">
                  <table className="ta-table tx-runs-table">
                    <thead><tr><th aria-label="State" /><th>When</th><th>What</th><th>Model</th><th>Took</th><th>Receipt</th></tr></thead>
                    <tbody>
                      {shown.map((r) => {
                        const k = keyOf(r);
                        const on = sel && sel.from === 'runs' && keyOf(sel.row) === k;
                        return (
                          <tr key={k} aria-selected={on} data-run={r.id} data-state={r.state} tabIndex={0} onClick={() => setSel({ from: 'runs', row: r })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel({ from: 'runs', row: r }); } }}>
                            <td className={`tx-runs-mark tx-runs-${r.state}`} aria-label={r.state}>{r.mark}</td>
                            <td className="tx-runs-when">{day(r.at)}</td>
                            <td className="ta-clip tx-runs-line" title={r.line}>{r.line}</td>
                            <td className="ta-clip tx-runs-model">{r.model || <span className="ta-muted">—</span>}</td>
                            <td className="tx-runs-took">{r.state === 'running' ? <StateWord word="running" /> : secs(r.ms) || <span className="ta-muted">—</span>}</td>
                            <td className="tx-runs-seal-cell"><Receipt r={r.receipt} />{r.receipt && hereIds.has(r.receipt.short) ? <span className="tx-runs-here" title="An answer of the conversation on the Chat" aria-label="in this chat">◆</span> : null}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
        {shown.some((r) => r.receipt && hereIds.has(r.receipt.short)) ? <p className="ta-muted"><span className="tx-runs-here" aria-hidden="true">◆</span> an answer of the conversation on the Chat · ✓ a receipt the companion verified in this reading</p> : null}
        {notes.length ? <ul className="tx-runs-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      </Panel>
      <Panel id="answers" kicker="THE CHAT" title="This conversation’s answers"
        tools={view ? <span className="ta-muted">read {clock(viewAt)}</span> : null}>
        {!view ? <Empty>Reading the conversation…</Empty> : !answers.length ? <Empty>No answer in this conversation yet.</Empty> : (
          <ul className="tx-runs-answers">
            {answers.map((t, i) => {
              const on = sel && sel.from === 'conversation' && sel.row === t;
              return (
                <li key={`${t.at}-${i}`}>
                  <button type="button" className="tx-runs-answer" aria-pressed={on} onClick={() => setSel({ from: 'conversation', row: t })}>
                    <span className="tx-runs-when">{day(t.at)}</span>
                    <span className="tx-runs-answer-text">{t.stopped ? '(stopped) ' : ''}{plain(t.text).slice(0, 120) || '(no words)'}</span>
                    <span className="tx-runs-answer-seal">{t.receipt ? <><span className={t.receipt.verified ? 'ta-verified' : 'ta-unverified'}>{t.receipt.verified ? '✓' : '✕'}</span> <code>{t.receipt.id}</code></> : <span className="ta-muted">no receipt matched</span>}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </Page>
  );
}
