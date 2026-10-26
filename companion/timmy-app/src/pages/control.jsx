// R12 (the finish brief): Control Room — Timmy's terminal panes and the room they belong to. From the companion, read-only:
// GET /api/panel/control/panes (the project's running jobs and the chat turns being answered, then its newest ended runs; each
// pane's name, mark and word, who started it, since when, its log's last lines, its exit and receipt) and GET
// /api/panel/control/room (what runs now and waits on you, the fleet in its three words, the budget the receipts measured).
// A pane's state is that run's, never the agent's: the Chat's turn activity is the Chat's. The one action this page takes is
// the companion's own Stop for a chat turn being answered (POST /api/chat/stop { turn }); a job is stopped with the command
// the workspace frame names, copied for the terminal — this page types into no terminal and opens none.
import { useEffect, useRef, useState } from 'react';
import { getJson, postJson } from '../api.js';
import { Page, Panel, Tool } from '../shell.jsx';
import { goTo, projectQuery, useApp } from '../store.js';
import { Button, Empty, Facts, StateWord, clock, day } from '../ui.jsx';
import { ConfigureRow, isConfigured, useInventory } from '../configure.jsx';
import './control.css';

const usd = (n) => (typeof n === 'number' && Number.isFinite(n) ? (n === 0 || n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`) : 'unknown');
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/** The room and the panes, read on open; the panes again every `every` ms (the companion's own pace) while anything runs. */
function useControl() {
  const [room, setRoom] = useState(null);
  const [panes, setPanes] = useState(null);
  const [asking, setAsking] = useState(false);
  const alive = useRef(true);
  const readPanes = async () => { const p = await getJson(`/api/panel/control/panes${projectQuery()}`); if (alive.current) setPanes({ ...p, readAt: new Date().toISOString() }); return p; };
  const readRoom = async () => { const r = await getJson(`/api/panel/control/room${projectQuery()}`); if (alive.current) setRoom({ ...r, readAt: new Date().toISOString() }); return r; };
  const read = async () => { setAsking(true); await Promise.all([readPanes(), readRoom()]); if (alive.current) setAsking(false); };
  useEffect(() => { alive.current = true; read(); return () => { alive.current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!panes || !panes.ok || !panes.running) return undefined;
    const t = setTimeout(() => { if (visible()) { readPanes(); readRoom(); } }, Math.max(1000, panes.every || 2000));
    return () => clearTimeout(t);
  }, [panes]); // eslint-disable-line react-hooks/exhaustive-deps
  return { room, panes, asking, read };
}

function Tail({ tail }) {
  if (!tail) return null;
  if (tail.why) return <p className="ta-muted tx-ctl-tail-why">{tail.why}</p>;
  const lines = Array.isArray(tail.lines) ? tail.lines : [];
  return lines.length ? <pre className="tx-ctl-tail" aria-label="The log's last lines">{lines.join('\n')}</pre> : <p className="ta-muted tx-ctl-tail-why">The log is empty.</p>;
}

function PaneCard({ p, on, onPick }) {
  const word = p.state ? p.state.word : 'unknown';
  return (
    <article className={`tx-ctl-pane${p.quiet ? ' is-quiet' : ''}${on ? ' is-on' : ''}${p.state && p.state.failed ? ' is-failed' : ''}`} data-pane={p.id}>
      <button type="button" className="tx-ctl-pane-head" aria-pressed={on} onClick={onPick}>
        <span className="tx-ctl-glyph" aria-hidden="true">{p.state ? p.state.glyph : '?'}</span>
        <span className="tx-ctl-pane-name">{p.name}</span>
        <StateWord word={word} />
      </button>
      <p className="tx-ctl-pane-line">{p.who}{p.from ? ` · from ${p.from}` : ''} · since {clock(p.since)}{p.took ? ` · ${p.took}` : ''}</p>
      <Tail tail={p.tail} />
    </article>
  );
}

function PaneDetail({ p, onCopy, copied }) {
  return (
    <div className="tx-ctl-detail">
      <p className="tx-ctl-detail-title">{p.state ? p.state.glyph : '?'} {p.name}</p>
      <Facts rows={[
        ['kind', p.kind === 'turn' ? 'a chat turn being answered' : 'a job'],
        ['state', <StateWord key="s" word={p.state ? p.state.word : 'unknown'} />],
        ['id', <code key="i">{p.id}</code>],
        ['started by', p.who],
        ['sent from', p.from || null],
        ['since', day(p.since)],
        ['ended', p.endedAt ? day(p.endedAt) : null],
        ['took', p.took || null],
        ['blocks', p.blocks || null],
        ['recovery', p.recovery || null],
        ['exit', p.exit || null],
        ['operation', p.operation ? <code key="o">{p.operation}</code> : p.noDetail || null],
        ['proof', p.proof || null],
      ]} />
      {p.receipt ? (
        <div className="tx-ctl-seal">
          <p className="ta-context-k">RECEIPT</p>
          <p>{p.receipt.state === 'verified' ? <span className="ta-verified">✓ verified</span> : <span className="ta-unverified">{p.receipt.state === 'none' ? 'none' : `✕ ${p.receipt.state}`}</span>} {p.receipt.id ? <code>{p.receipt.id}</code> : null}</p>
          <p className="ta-muted">{p.receipt.words}</p>
        </div>
      ) : null}
      {p.stop ? (
        <div className="tx-ctl-seal">
          <p className="ta-context-k">HOW IT IS STOPPED</p>
          <p className="ta-muted">{p.stop.words}</p>
          {p.stop.command ? <div className="ta-row"><code className="tx-ctl-cmd">{p.stop.command}</code><Button onClick={() => onCopy(p.stop.command)}>Copy</Button></div> : null}
          {copied ? <p className="ta-muted" role="status">{copied}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function RoomContext({ room }) {
  if (!room) return <p className="ta-muted">Reading the room…</p>;
  if (!room.ok) return <p className="ta-result" role="status">{room.error || `The companion answered ${room.status || 'nothing'}.`}</p>;
  const b = room.budget || {};
  return (
    <>
      <div className="tx-ctl-block">
        <p className="ta-context-k">CONNECTIONS</p>
        {(room.connections || []).length ? (
          <ul className="tx-ctl-list">
            {room.connections.map((c) => (
              <li key={c.id}><p className="tx-ctl-row"><strong>{c.label}</strong> <StateWord word={c.state} live={c.state === 'connected' && !!c.observedAt} /></p><p className="ta-muted">{c.words}</p>{c.setup ? <p className="ta-muted">Set up in the terminal: <code>{c.setup}</code></p> : null}</li>
            ))}
          </ul>
        ) : <p className="ta-muted">The workspace frame named no connection.</p>}
      </div>
      <div className="tx-ctl-block">
        <p className="ta-context-k">BUDGET</p>
        <Facts rows={[
          ['measured', `${usd(b.measuredUsd)} over ${b.receipts ?? 0} receipt${b.receipts === 1 ? '' : 's'}`],
          ['unmeasured', typeof b.unmeasured === 'number' ? `${b.unmeasured} said unknown` : null],
          ['free only', b.from ? `${b.freeOnly ? 'on' : 'off'} (${b.from.freeOnly})` : null],
          ['local only', b.from ? `${b.localOnly ? 'on' : 'off'} (${b.from.localOnly})` : null],
          ['cap', b.cap || null],
        ]} />
      </div>
    </>
  );
}

export default function ControlPage() {
  const { room, panes, asking, read } = useControl();
  const turn = useApp((s) => s.turn);
  const [selId, setSelId] = useState(null);
  const [said, setSaid] = useState('');
  const [copied, setCopied] = useState('');
  const [stopping, setStopping] = useState(false);
  const pOk = panes && panes.ok;
  const rOk = room && room.ok;
  const list = pOk && Array.isArray(panes.panes) ? panes.panes : [];
  const sel = list.find((p) => p.id === selId) || null;
  const a = rOk ? room.activity : null;
  const fleet = rOk && Array.isArray(room.fleet) ? room.fleet : [];
  const count = (w) => fleet.filter((f) => f.word === w).length;
  // the fleet's rows as configure rows: the inventory itself (its available + configured facts), the one aid for each
  const inv = useInventory();
  const fleetRows = inv && inv.ok && inv.inventory ? (inv.inventory.rows || []).filter((r) => r.group === 'Lanes' || r.group === 'Integrations') : [];
  const cardOf = new Map(((inv && inv.cards) || []).map((c) => [c.id, c]));
  const copy = async (text) => {
    try {
      if (!window.isSecureContext || !navigator.clipboard) throw new Error('no clipboard on this page');
      await navigator.clipboard.writeText(text);
      setCopied(`Copied ${text}: paste it in Timmy’s terminal. Nothing ran from this page.`);
    } catch (e) { setCopied(`Could not copy (${e instanceof Error ? e.message : String(e)}); the command is ${text}.`); }
  };
  const stopTurn = async (id) => {
    if (!id || stopping) return;
    setStopping(true);
    const r = await postJson(`/api/chat/stop${projectQuery()}`, { turn: id });
    setSaid(r.words || r.error || `The companion answered ${r.status || 'nothing'}.`);
    setStopping(false);
    read();
  };
  // the head's one next step, by what runs (as the companion's own Control Room page chooses it)
  const actions = a && a.chatTurn && a.chatTurn.id ? <Button kind="primary" onClick={() => stopTurn(a.chatTurn.id)} disabled={stopping}>{stopping ? 'Stopping…' : '■ Stop the turn'}</Button>
    : a && a.stop && a.stop.command ? <Button kind="primary" onClick={() => copy(a.stop.command)}>Copy the stop command</Button>
      : a && a.waitingOnYou > 0 ? <Button kind="primary" onClick={() => goTo('chat')}>Answer in Chat</Button>
        : <Button onClick={() => goTo('runs')}>Open Runs &amp; receipts</Button>;
  const thisPage = turn && ['running', 'stopping'].includes(turn.phase);
  return (
    <Page id="control"
      actions={actions}
      note={said || copied || null}
      band={[
        ['RUNNING', !panes ? <span className="ta-muted">reading…</span> : pOk ? (panes.running ? <StateWord word={`${panes.running} running`} /> : <span className="ta-muted">nothing</span>) : <span className="ta-muted">not read</span>],
        ['WAITING ON YOU', a ? (a.waitingOnYou ? <StateWord word={`${a.waitingOnYou} waiting`} /> : <span className="ta-muted">nothing</span>) : <span className="ta-muted">—</span>],
        ['FLEET', rOk ? <>{count('exercised')} exercised <span className="ta-muted">· {count('configured')} configured · {count('available')} available</span></> : <span className="ta-muted">—</span>],
        ['BUDGET', rOk ? <>{usd(room.budget.measuredUsd)} <span className="ta-muted">measured</span></> : <span className="ta-muted">—</span>],
      ]}
      context={sel ? <PaneDetail p={sel} onCopy={copy} copied={copied} /> : <RoomContext room={room} />}
      contextTitle={sel ? 'The selected pane' : 'The room'}
      tools={<>
        <span className="ta-toolsrow-k">ROOM</span>
        <Tool glyph="■" label="Stop the turn" onClick={a && a.chatTurn && a.chatTurn.id && !stopping ? () => stopTurn(a.chatTurn.id) : null} why={a && a.chatTurn ? (a.chatTurn.id ? '' : 'the turn names no id to stop') : 'no chat turn is being answered'} />
        <Tool glyph="⎘" label="Copy the stop command" onClick={a && a.stop && a.stop.command ? () => copy(a.stop.command) : null} why={a && a.stop ? 'the frame names no command' : 'no job runs'} />
        <Tool glyph="↻" label={asking ? 'Reading…' : 'Read again'} onClick={asking ? null : read} />
        <span className="ta-toolsrow-sep" aria-hidden="true" />
        <Tool glyph=">_" label="Open a terminal" why="this page opens and types into no terminal" />
        {sel ? <Tool glyph="✕" label="Close the pane’s facts" onClick={() => setSelId(null)} /> : null}
      </>}>
      <Panel id="now" kicker="NOW" title="What runs now"
        tools={rOk ? <span className="ta-muted">read {clock(room.readAt)} · GET /api/panel/control/room</span> : null}>
        {!room ? <Empty>Reading the room…</Empty> : !rOk ? <p className="ta-result" role="status">{room.error || `The companion answered ${room.status || 'nothing'}.`}</p> : (
          <>
            {a.chatTurn ? (
              <p className="tx-ctl-row"><StateWord word="answering" /> A chat turn sent from {a.chatTurn.surface}, since {clock(a.chatTurn.since)}: {a.chatTurn.words}</p>
            ) : null}
            {a.stop ? <p className="tx-ctl-row"><StateWord word={`${a.running} running`} /> {a.stop.words}</p> : null}
            {!a.chatTurn && !a.running ? <Empty>Nothing runs in this project now, and nothing waits on you.</Empty> : null}
            {a.waitingOnYou ? <p className="tx-ctl-row"><StateWord word="waiting on you" /> {a.waitingOnYou} thing{a.waitingOnYou === 1 ? '' : 's'} wait{a.waitingOnYou === 1 ? 's' : ''} for your answer in the Chat.</p> : null}
            <p className="ta-muted">The agent on the Chat page is {thisPage ? `working on this page’s turn (${turn.phase})` : 'not running a turn from this page'}; the panes below are the project’s runs, each in its own state.</p>
          </>
        )}
        {rOk && room.notes && room.notes.length ? <ul className="tx-ctl-notes">{room.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      </Panel>
      <Panel id="panes" kicker="PANES" title="The project’s runs, as panes"
        tools={pOk ? <span className="ta-muted">{panes.running ? `read every ${Math.round((panes.every || 2000) / 1000)} s while it runs · ` : ''}read {clock(panes.readAt)}</span> : null}>
        {!panes ? <Empty>Reading the panes…</Empty> : !pOk ? <p className="ta-result" role="status">{panes.error || `The companion answered ${panes.status || 'nothing'}.`}</p>
          : !list.length ? <Empty>No pane: no job of this project has run here, and no chat turn is being answered. A workflow run started in the terminal shows here with its log.</Empty> : (
            <div className="tx-ctl-panes">
              {list.map((p) => <PaneCard key={p.id} p={p} on={selId === p.id} onPick={() => setSelId(selId === p.id ? null : p.id)} />)}
            </div>
          )}
        {pOk && panes.more ? <p className="ta-muted">{panes.more} more run{panes.more === 1 ? 's' : ''} than the panes shown.</p> : null}
        {pOk && panes.notes && panes.notes.length ? <ul className="tx-ctl-notes">{panes.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      </Panel>
      <Panel id="fleet" kicker="FLEET" title="Lanes and integrations"
        tools={fleetRows.length ? <span className="ta-muted">{fleetRows.filter(isConfigured).length} of {fleetRows.length} configured</span> : null}>
        {!inv ? <Empty>Reading what is on this computer…</Empty> : !inv.ok ? <Empty>{inv.error || 'The companion did not answer the inventory.'}</Empty>
          : !fleetRows.length ? <Empty>The capability inventory listed no lane or integration.</Empty> : (
            <ul className="ta-cfg-list" aria-label="Lanes and integrations">
              {fleetRows.map((r) => <ConfigureRow key={r.id} row={r} card={cardOf.get(r.id)} />)}
            </ul>
          )}
      </Panel>
    </Page>
  );
}
