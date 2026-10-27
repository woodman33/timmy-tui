// The integrated candidate's checklist B1–B8: the Control Room's agent runs (src/companion/control-runs.ts). Review a run (the
// adapter's own plan, nothing started) → Approve and start (a copy of the project, through `timmy act "/agent …"`) → follow its
// log and its face (fed by the run's own record) → Stop (act's own stop path) → its end: the changed files and their diffs, the
// final message, the receipt in this project. An act gone without its end is interrupted, and Recover settles it.
import { useEffect, useRef, useState } from 'react';
import { getJson, postJson } from '../api.js';
import { Panel } from '../shell.jsx';
import { projectQuery, useApp } from '../store.js';
import { Button, Empty, Facts, StateWord, clock, day } from '../ui.jsx';
import { RunFace } from '../rive.jsx';

const EVERY_MS = 1500;
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const said = (r) => r.error || `The companion answered ${r.status || 'nothing'}.`;

function useRuns() {
  const [runs, setRuns] = useState(null);
  const alive = useRef(true);
  const read = async () => { const r = await getJson(`/api/control/runs${projectQuery()}`); if (alive.current) setRuns(r); return r; };
  useEffect(() => { alive.current = true; read(); return () => { alive.current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!runs || !runs.ok || !(runs.runs || []).some((r) => r.live)) return undefined;
    const t = setTimeout(() => { if (visible()) read(); }, EVERY_MS);
    return () => clearTimeout(t);
  }, [runs]); // eslint-disable-line react-hooks/exhaustive-deps
  return { runs, read };
}

/** The review form: harness, model, task, time limit → the proposal (nothing starts until Approve and start). */
function Launch({ onStarted }) {
  const [h, setH] = useState(null);
  const [harness, setHarness] = useState('qwen');
  const [model, setModel] = useState('');
  const [task, setTask] = useState('');
  const [limit, setLimit] = useState(10);
  const [proposal, setProposal] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { getJson(`/api/control/harnesses${projectQuery()}`).then((r) => { setH(r); if (r.ok && r.models && r.models.length) setModel((m) => m || r.models[0]); if (r.ok && r.limit) setLimit(r.limit.default); }); }, []);
  const review = async (e) => {
    e.preventDefault();
    setBusy(true); setNote(''); setProposal(null);
    const r = await postJson(`/api/control/propose${projectQuery()}`, { harness, model, task, limit: Number(limit) });
    setBusy(false);
    if (r.ok) setProposal(r.proposal); else setNote(said(r));
  };
  const start = async () => {
    if (!proposal) return;
    setBusy(true);
    const r = await postJson(`/api/control/runs${projectQuery()}`, { proposal: proposal.id });
    setBusy(false);
    if (r.ok) { setProposal(null); setTask(''); setNote(`Started run ${r.run.id}.`); onStarted(r.run); } else { setProposal(null); setNote(said(r)); }
  };
  if (!h) return <p className="ta-muted">Reading what can run here…</p>;
  if (!h.ok) return <p className="ta-result" role="status">{said(h)}</p>;
  const hs = h.harnesses || [];
  const cur = hs.find((x) => x.id === harness);
  return (
    <form className="tx-ctl-launch" onSubmit={review} aria-label="Start a code-agent run">
      <div className="tx-ctl-launch-row">
        <label className="tx-ctl-field"><span>Harness</span>
          <select value={harness} onChange={(e) => { setHarness(e.target.value); setProposal(null); }}>
            {hs.map((x) => <option key={x.id} value={x.id}>{x.title}{x.found ? '' : ' (not set up)'}</option>)}
          </select>
        </label>
        <label className="tx-ctl-field"><span>Model (this computer’s Ollama)</span>
          {h.models && h.models.length ? (
            <select value={model} onChange={(e) => { setModel(e.target.value); setProposal(null); }}>
              {h.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : <input value={model} onChange={(e) => { setModel(e.target.value); setProposal(null); }} placeholder="a name from ollama list" aria-describedby="tx-ctl-models-why" />}
        </label>
        <label className="tx-ctl-field tx-ctl-field-short"><span>Time limit (min)</span>
          <input type="number" min="1" max={h.limit ? h.limit.max : 60} value={limit} onChange={(e) => { setLimit(e.target.value); setProposal(null); }} />
        </label>
      </div>
      {h.modelsError ? <p className="ta-muted" id="tx-ctl-models-why">No model list: {h.modelsError}.</p> : null}
      {cur && cur.needs ? <p className="ta-muted">{cur.title} needs setup: {cur.needs}.</p> : null}
      <label className="tx-ctl-field"><span>Task</span>
        <textarea rows={3} value={task} onChange={(e) => { setTask(e.target.value); setProposal(null); }} placeholder={`What ${cur ? cur.title : 'the agent'} should do in a copy of ${h.project ? h.project.name : 'this project'}`} />
      </label>
      {!proposal ? (
        <div className="ta-row"><Button kind="primary" type="submit" disabled={busy || !task.trim() || !model}>{busy ? 'Checking…' : 'Review the run'}</Button><span className="ta-muted">Nothing starts until you approve it.</span></div>
      ) : (
        <div className="tx-ctl-proposal" role="group" aria-label="The run to approve">
          <p className="ta-context-k">APPROVE THIS RUN</p>
          <Facts rows={[
            ['harness', proposal.title],
            ['model', `${proposal.model} at ${proposal.where}`],
            ['charge', proposal.charge],
            ['time limit', proposal.wall_time],
            ['works on', proposal.workspace],
            ['checked', proposal.preflight],
          ]} />
          <ul className="tx-ctl-facts">{proposal.may.map((m) => <li key={m}>It may {m}.</li>)}</ul>
          <div className="ta-row">
            <Button kind="primary" onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Approve and start'}</Button>
            <Button onClick={() => setProposal(null)} disabled={busy}>Cancel</Button>
            <span className="ta-muted">This approval is good until {clock(proposal.expires_at)}.</span>
          </div>
        </div>
      )}
      {note ? <p className="ta-result" role="status">{note}</p> : null}
    </form>
  );
}

function Diffs({ id }) {
  const [d, setD] = useState(null);
  return (
    <details className="ta-details" onToggle={(e) => { if (e.currentTarget.open && !d) getJson(`/api/control/runs/${id}/diff${projectQuery()}`).then(setD); }}>
      <summary>The changes, as diffs against the project</summary>
      {!d ? <p className="ta-muted">Reading…</p> : !d.ok ? <p className="ta-result">{said(d)}</p> : !d.files.length ? <p className="ta-muted">The run changed no file.</p> : (
        <>
          {d.files.map((f) => (
            <div key={f.path} className="tx-ctl-diff">
              <p className="tx-ctl-row"><code>{f.path}</code> <span className="ta-muted">{f.kind}</span></p>
              {f.diff ? <pre className="tx-ctl-tail tx-ctl-diff-pre">{f.diff}</pre> : <p className="ta-muted">{f.why}</p>}
            </div>
          ))}
          {d.more ? <p className="ta-muted">{d.more} more changed file{d.more === 1 ? '' : 's'} not shown.</p> : null}
        </>
      )}
    </details>
  );
}

function RunCard({ r, theme, onChange }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const act = async (what) => {
    setBusy(true);
    const x = await postJson(`/api/control/runs/${r.id}/${what}${projectQuery()}`, {});
    setBusy(false);
    setNote(x.ok ? (what === 'stop' ? 'Stop sent: the run ends through its own stop.' : 'Recovered: read again below.') : said(x));
    onChange();
  };
  const res = r.result;
  const files = res && res.files ? [...res.files.added, ...res.files.changed, ...res.files.deleted] : [];
  return (
    <article className={`tx-ctl-run${r.live ? ' is-live' : ''}`} data-run={r.id} data-state={r.state}>
      <div className="tx-ctl-run-head">
        <RunFace id={r.id} state={r.state} live={r.live} theme={theme} />
        <div className="tx-ctl-run-words">
          <p className="tx-ctl-row"><strong>{r.title}</strong> <StateWord word={r.state} live={r.live} /> <span className="ta-muted">{r.model} · since {clock(r.started_at)}{r.ended_at ? ` · ended ${clock(r.ended_at)}` : ''}</span></p>
          <p className="tx-ctl-run-task">{r.task}</p>
          {r.why && !r.live ? <p className="ta-muted">{r.why}</p> : null}
          <div className="ta-row">
            {r.live ? <Button kind="primary" onClick={() => act('stop')} disabled={busy || r.state === 'stopping'}>{r.state === 'stopping' ? 'Stopping…' : '■ Stop'}</Button> : null}
            {r.state === 'interrupted' ? <Button kind="primary" onClick={() => act('recover')} disabled={busy}>Recover</Button> : null}
            {note ? <span className="ta-muted" role="status">{note}</span> : null}
          </div>
        </div>
      </div>
      {r.log && r.log.length ? <pre className="tx-ctl-tail" aria-label="The run's last log lines">{r.log.join('\n')}</pre> : <p className="ta-muted tx-ctl-tail-why">{r.live ? 'No log line yet.' : 'It wrote no log line.'}</p>}
      {!r.live && res ? (
        <div className="tx-ctl-seal">
          <p className="ta-context-k">ITS END</p>
          <p>{res.outcome ? <StateWord word={res.outcome} /> : null} {files.length ? `${files.length} file${files.length === 1 ? '' : 's'} changed in its copy: ${files.slice(0, 6).join(', ')}${files.length > 6 ? '…' : ''}` : 'No file changed.'}</p>
          {res.final_message ? <blockquote className="tx-ctl-final">{res.final_message}</blockquote> : null}
          {files.length ? <Diffs id={r.id} /> : null}
        </div>
      ) : null}
      <details className="ta-details">
        <summary>Details</summary>
        <Facts rows={[
          ['run', <code key="r">{r.id}</code>],
          ['operation', r.operation ? <code key="o">{r.operation}</code> : 'not yet'],
          ['job', r.job ? <code key="j">{r.job}</code> : null],
          ['agent run', r.agent_run ? <code key="a">{r.agent_run}</code> : null],
          ['endpoint', `${r.where} (${r.charge})`],
          ['time limit', r.wall_time],
          ['approved', `${day(r.approved.at)} · plan ${r.approved.plan_sha256.slice(0, 12)}`],
          ['copy', `${r.workspace.files} files, ${Math.round(r.workspace.bytes / 1024)} KB; left out: ${r.workspace.skipped.join(', ') || 'nothing'}`],
          ['timmy act', r.act ? `${r.act.outcome}, exit ${r.act.exit_code}` : r.exit ? `ended without its end (${r.exit.signal || `exit ${r.exit.code}`})` : r.live ? 'running' : 'no end read'],
          ['stopped by', r.stop ? `${r.stop.by}, ${clock(r.stop.asked_at)}` : null],
          ['agent receipt', res && res.agent_receipt ? <code key="ar">{res.agent_receipt}</code> : null],
          ['receipt here', r.receipt ? <code key="rc">{r.receipt}</code> : r.live ? 'sealed when it ends' : 'none'],
          ['read from', `GET /api/control/runs/${r.id}`],
        ]} />
      </details>
    </article>
  );
}

export function AgentRuns() {
  const { runs, read } = useRuns();
  const theme = useApp((s) => s.theme);
  const list = runs && runs.ok ? runs.runs || [] : [];
  const live = list.filter((r) => r.live).length;
  return (
    <Panel id="agent-runs" kicker="AGENT RUNS" title="Run a code agent on a copy of this project"
      tools={live ? <StateWord word={`${live} running`} live /> : null}>
      <Launch onStarted={() => read()} />
      {!runs ? <Empty>Reading the runs…</Empty> : !runs.ok ? <p className="ta-result" role="status">{said(runs)}</p>
        : !list.length ? <Empty>No run yet. Review one above: OpenHands or Qwen Code, on a model of this computer.</Empty>
          : <div className="tx-ctl-runs">{list.map((r) => <RunCard key={r.id} r={r} theme={theme} onChange={read} />)}</div>}
    </Panel>
  );
}
