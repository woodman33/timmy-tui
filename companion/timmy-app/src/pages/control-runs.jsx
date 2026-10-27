// The integrated candidate's checklist B1–B8: the Control Room's agent runs (src/companion/control-runs.ts). Review a run (the
// adapter's own plan, nothing started) → Approve and start (a copy of the project, through `timmy act "/agent …"`) → follow its
// log and its face (fed by the run's own record) → Stop (act's own stop path) → its end: the changed files and their diffs, the
// final message, the receipt in this project. An act gone without its end is interrupted, and Recover settles it.
import { useEffect, useRef, useState } from 'react';
import { getJson, postJson } from '../api.js';
import { Panel } from '../shell.jsx';
import { projectQuery, takeAgentTarget, useApp } from '../store.js';
import { Button, Empty, Facts, StateWord, clock, day } from '../ui.jsx';
import { RunFace } from '../rive.jsx';

const EVERY_MS = 1500;
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
/** The apps a run can be aimed at (their outputs in from-apps/<app>/ of the run's copy). */
const TARGET_APPS = [['card-lab', 'Card Lab'], ['film-room', 'Film Room'], ['model-studio', 'Model Studio'], ['stream-studio', 'Stream Studio'], ['animate', 'Animate']];
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
function Launch({ onStarted, only }) {
  const [h, setH] = useState(null);
  const [harness, setHarness] = useState(only || 'qwen');
  // what the run works on: the project, or an app's outputs (or one of them), as a page that sent it here aimed it
  const [target, setTarget] = useState(() => takeAgentTarget() || { kind: 'project' });
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
    const r = await postJson(`/api/control/propose${projectQuery()}`, { harness, model, task, limit: Number(limit), target: target.kind === 'app' ? { kind: 'app', app: target.app, ...(target.path ? { path: target.path } : {}) } : { kind: 'project' } });
    setBusy(false);
    if (r.ok) setProposal(r.proposal); else setNote(said(r));
  };
  const start = async () => {
    if (!proposal) return;
    setBusy(true);
    const r = await postJson(`/api/control/runs${projectQuery()}`, { proposal: proposal.id });
    setBusy(false);
    if (r.ok) { setProposal(null); setTask(''); setNote(''); onStarted(r.run); } else { setProposal(null); setNote(said(r)); }
  };
  if (!h) return <p className="ta-muted">Reading what can run here…</p>;
  if (!h.ok) return <p className="ta-result" role="status">{said(h)}</p>;
  const hs = h.harnesses || [];
  const cur = hs.find((x) => x.id === harness);
  return (
    <form className="tx-ctl-launch" onSubmit={review} aria-label="Start a code-agent run">
      <div className="tx-ctl-launch-row">
        {only ? null : (
          <label className="tx-ctl-field"><span>Harness</span>
            <select value={harness} onChange={(e) => { setHarness(e.target.value); setProposal(null); }}>
              {hs.map((x) => <option key={x.id} value={x.id}>{x.title}{x.found ? '' : ' (not set up)'}</option>)}
            </select>
          </label>
        )}
        <label className="tx-ctl-field"><span>Model (this computer’s Ollama)</span>
          {h.models && h.models.length ? (
            <select value={model} onChange={(e) => { setModel(e.target.value); setProposal(null); }}>
              {h.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : <input value={model} onChange={(e) => { setModel(e.target.value); setProposal(null); }} placeholder="a name from ollama list" aria-describedby="tx-ctl-models-why" />}
        </label>
        <label className="tx-ctl-field"><span>Works on</span>
          <select value={target.kind === 'app' ? `${target.app}${target.path ? `|${target.path}` : ''}` : 'project'} data-ctl="target"
            onChange={(e) => { const v = e.target.value; setProposal(null); if (v === 'project') setTarget({ kind: 'project' }); else { const [app, path] = v.split('|'); setTarget({ kind: 'app', app, ...(path ? { path } : {}) }); } }}>
            <option value="project">This project</option>
            {TARGET_APPS.map(([id, words]) => <option key={id} value={id}>{words}’s outputs</option>)}
            {target.kind === 'app' && target.path ? <option value={`${target.app}|${target.path}`}>{target.path}</option> : null}
          </select>
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
            ['works on', proposal.target ? proposal.target.words : 'the whole project'],
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

const OUTCOME = {
  succeeded: { mark: '✓', word: 'Succeeded' },
  stopped: { mark: '■', word: 'Stopped' },
  failed: { mark: '!', word: 'Failed' },
  interrupted: { mark: '!', word: 'Interrupted' },
  refused: { mark: '!', word: 'Refused' },
};

/** An ended run's one outcome sentence: who or what ended it, when, and what it changed. */
function outcomeLine(r, files) {
  const at = r.ended_at ? clock(r.ended_at) : '';
  // (who stopped it, as the record says: the page's Stop is "the Control Room's Stop"; the companion's own shutdown names itself)
  const by = r.stop && r.stop.by ? r.stop.by : '';
  const how = r.state === 'stopped' ? `Stopped${/Control Room/.test(by) ? ' from the Control Room' : by ? ` by ${by}` : ''}${at ? ` at ${at}` : ''}`
    : r.state === 'interrupted' ? `Interrupted${at ? ` at ${at}` : ''}: its launcher ended without its end. Recover settles it`
      : `${(OUTCOME[r.state] || { word: r.state }).word}${at ? ` at ${at}` : ''}`;
  const what = files.length ? `${files.length} file${files.length === 1 ? '' : 's'} changed in its copy` : 'no file changed';
  return `${how}; ${what}.`;
}

function RunCard({ r, theme, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (what) => {
    setBusy(true);
    const x = await postJson(`/api/control/runs/${r.id}/${what}${projectQuery()}`, {});
    setBusy(false);
    setError(x.ok ? '' : said(x));
    onChange();
  };
  const res = r.result;
  const files = res && res.files ? [...res.files.added, ...res.files.changed, ...res.files.deleted] : [];
  const out = OUTCOME[r.state];
  const log = r.log && r.log.length ? <pre className="tx-ctl-tail" aria-label="The run's last log lines">{r.log.join('\n')}</pre> : <p className="ta-muted tx-ctl-tail-why">{r.live ? 'No log line yet.' : 'It wrote no log line.'}</p>;
  // The run's event history, in order: kept for Details; the card's face says only the current state or the one outcome.
  const history = [
    ['approved', r.approved ? `${day(r.approved.at)} · plan ${r.approved.plan_sha256.slice(0, 12)}` : null],
    ['started', r.started_at ? clock(r.started_at) : null],
    ['stop asked', r.stop ? `${r.stop.by}, ${clock(r.stop.asked_at)}` : null],
    ['timmy act ended', r.act ? `${r.act.outcome}, exit ${r.act.exit_code}` : r.exit ? `without its end (${r.exit.signal || `exit ${r.exit.code}`})` : null],
    ['the agent said', res && res.outcome ? res.outcome : null],
    ['why', r.why || null],
    ['ended', r.ended_at ? clock(r.ended_at) : null],
  ];
  return (
    <article className={`tx-ctl-run${r.live ? ' is-live' : ' is-ended'}`} data-run={r.id} data-state={r.state} data-outcome={r.live ? undefined : r.state}>
      <div className="tx-ctl-run-head">
        {r.live ? <RunFace id={r.id} state={r.state} live theme={theme} />
          : <div className={`tx-ctl-outcome tx-ctl-outcome-${r.state}`} aria-hidden="true"><span className="tx-ctl-outcome-mark">{out ? out.mark : '·'}</span><span className="tx-ctl-outcome-word">{out ? out.word : r.state}</span></div>}
        <div className="tx-ctl-run-words">
          <p className="tx-ctl-row"><strong>{r.title}</strong> {r.live ? <StateWord word={r.state} live /> : null} <span className="ta-muted">{r.model} · {clock(r.started_at)}</span></p>
          <p className="tx-ctl-run-task">{r.task}</p>
          {r.target && r.target.kind === 'app' ? <p className="ta-muted" data-run-target={r.target.app}>Works on {r.target.words}</p> : null}
          {r.live ? null : <p className="tx-ctl-outcome-line" role="status"><strong>{outcomeLine(r, files)}</strong></p>}
          <div className="ta-row">
            {r.live ? <Button kind="primary" onClick={() => act('stop')} disabled={busy || r.state === 'stopping'}>{r.state === 'stopping' ? 'Stopping…' : '■ Stop'}</Button> : null}
            {r.state === 'interrupted' ? <Button kind="primary" onClick={() => act('recover')} disabled={busy}>Recover</Button> : null}
            {error ? <span className="ta-result" role="status">{error}</span> : null}
          </div>
        </div>
      </div>
      {r.live ? log : null}
      {!r.live && res ? (
        <div className="tx-ctl-seal">
          {files.length ? <ul className="tx-ctl-files" aria-label="Files the run changed">{files.slice(0, 8).map((f) => <li key={f}><code>{f}</code></li>)}{files.length > 8 ? <li className="ta-muted">and {files.length - 8} more</li> : null}</ul> : null}
          {res.final_message ? <blockquote className="tx-ctl-final">{res.final_message}</blockquote> : null}
          {res.denied && res.denied.length ? <p className="ta-muted">It asked for {res.denied.join(', ')}: refused (a run here has no one to answer a permission; only file edits are approved for it).</p> : null}
          {res.tool_calls === 0 && !files.length && r.state === 'succeeded' ? <p className="ta-muted">It made no tool call: the model answered without using the agent’s tools.</p> : null}
          {files.length ? <Diffs id={r.id} /> : null}
        </div>
      ) : null}
      {!r.live ? <p className="tx-ctl-receipt">Receipt {r.receipt ? <code>{r.receipt}</code> : <span className="ta-muted">none sealed</span>}</p> : null}
      <details className="ta-details">
        <summary>Details: event history, log and identifiers</summary>
        <p className="ta-context-k">EVENT HISTORY</p>
        <Facts rows={history} />
        {!r.live ? <><p className="ta-context-k">LOG</p>{log}</> : null}
        <p className="ta-context-k">IDENTIFIERS</p>
        <Facts rows={[
          ['run', <code key="r">{r.id}</code>],
          ['operation', r.operation ? <code key="o">{r.operation}</code> : 'not yet'],
          ['job', r.job ? <code key="j">{r.job}</code> : null],
          ['agent run', r.agent_run ? <code key="a">{r.agent_run}</code> : null],
          ['endpoint', `${r.where} (${r.charge})`],
          ['time limit', r.wall_time],
          ['copy', `${r.workspace.files} files, ${Math.round(r.workspace.bytes / 1024)} KB; left out: ${r.workspace.skipped.join(', ') || 'nothing'}`],
          ['agent receipt', res && res.agent_receipt ? <code key="ar">{res.agent_receipt}</code> : null],
          ['receipt here', r.receipt ? <code key="rc">{r.receipt}</code> : r.live ? 'sealed when it ends' : 'none'],
          ['read from', `GET /api/control/runs/${r.id}`],
        ]} />
      </details>
    </article>
  );
}

/** The AGENT RUNS panel; `only` (a harness id) keeps it to that harness: the OpenHands sandbox page's own runs. */
export function AgentRuns({ only = null, title = 'Run a code agent on a copy of this project' } = {}) {
  const { runs, read } = useRuns();
  const theme = useApp((s) => s.theme);
  const list = (runs && runs.ok ? runs.runs || [] : []).filter((r) => !only || r.harness === only);
  const live = list.filter((r) => r.live).length;
  return (
    <Panel id={only ? `agent-runs-${only}` : 'agent-runs'} kicker="AGENT RUNS" title={title}
      tools={live ? <StateWord word={`${live} running`} live /> : null}>
      <Launch onStarted={() => read()} only={only} />
      {!runs ? <Empty>Reading the runs…</Empty> : !runs.ok ? <p className="ta-result" role="status">{said(runs)}</p>
        : !list.length ? <Empty>{only ? 'No run of this harness yet. Review one above, on a model of this computer.' : 'No run yet. Review one above: OpenHands or Qwen Code, on a model of this computer.'}</Empty>
          : <div className="tx-ctl-runs">{list.map((r) => <RunCard key={r.id} r={r} theme={theme} onChange={read} />)}</div>}
    </Panel>
  );
}
