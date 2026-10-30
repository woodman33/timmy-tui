// The unified Workspace order (2026-10-27): what a Control Room run is aimed at, as three different things, never blurred.
//
//   Files            a code agent (OpenHands, Qwen Code) edits a COPY of the project, or of an app's delivered outputs: the
//                    existing AGENT RUNS form (./control-runs.jsx); it never drives a live app
//   An app's operation  the app itself does the work, as its own job, through the adapter Timmy has for it (the same
//                    validated Workspace operation an operation node runs: /api/workflow, src/companion/workflow-ops.ts); the
//                    result is read back: every delivered file hashed again and compared with its receipt
//   The canvas selection  the canvas agent plans edits to the nodes chosen on the canvas; the canvas opens with its agent
//                    aimed there (only the canvas page can apply edits to its board)
//
// What can run comes from the ONE integration catalog (GET /api/catalog): an operation whose app is not installed is listed
// with the catalog's own words, never as a working choice.

import { useEffect, useRef, useState } from 'react';
import { getJson, postJson } from '../api.js';
import { appName } from '../app-names.js';
import { useCatalog } from '../catalog.jsx';
import { aimCanvasAgent, goTo, projectQuery, showInFiles, useApp } from '../store.js';
import { Button, Facts, StateWord } from '../ui.jsx';
import { operations } from './op-node.jsx';

export const TARGET_KINDS = [['files', 'Files', 'A code agent edits a copy of the project or of an app’s outputs.'], ['app', 'An app’s operation', 'The app does the work as its own job, through its adapter; the result is read back.'], ['canvas', 'The canvas selection', 'The canvas agent plans edits to the nodes chosen on the canvas.']];
const TERMINAL = new Set(['failed', 'cancelled', 'completed', 'interrupted']);
const EXT = (p) => (/\.([a-z0-9]+)$/i.exec(String(p || '')) || [])[1]?.toLowerCase() || '';
const said = (r) => r.error || (r.problems && r.problems.join(' ')) || `The companion answered ${r.status || 'nothing'}.`;

export function TargetKinds({ kind, onKind }) {
  return (
    <div className="tx-ctl-kinds" role="radiogroup" aria-label="What the run works on">
      {TARGET_KINDS.map(([id, label, hint]) => (
        <label key={id} className={`tx-ctl-kind${kind === id ? ' is-on' : ''}`} title={hint}>
          <input type="radio" name="tx-ctl-kind" value={id} checked={kind === id} onChange={() => onKind(id)} data-ctl-kind={id} />
          <span className="tx-ctl-kind-label">{label}</span>
          <span className="tx-ctl-kind-hint">{hint}</span>
        </label>
      ))}
    </div>
  );
}

/** An app's operation, run through its adapter as the app's own job, and its result read back. */
export function AppOperationRun() {
  const { answer } = useCatalog();
  const [specs, setSpecs] = useState([]);
  const [files, setFiles] = useState(null);
  const [opId, setOpId] = useState('');
  const [inputs, setInputs] = useState({});
  const [params, setParams] = useState({});
  const [run, setRun] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; operations().then(setSpecs); getJson(`/api/apps/outputs${projectQuery()}`).then(setFiles); return () => { alive.current = false; }; }, []);
  // each hosted app's operations, and (the spatial tools order) the spatial tools' (Timmy's own jobs; gsplat listed with its reason)
  const spatial = (e) => e.id.startsWith('spatial:');
  const entries = answer && answer.ok ? answer.catalog.entries.filter((e) => (e.kind === 'app' && e.operations.some((o) => o.where.includes('canvas'))) || spatial(e)) : [];
  const offered = entries.flatMap((e) => e.operations.filter((o) => o.where.includes('canvas') || spatial(e)).map((o) => {
    const spec = specs.find((x) => x.id === o.id);
    return { id: o.id, label: o.label, app: spatial(e) ? `3D Model Studio · ${e.name}` : e.name, spec, why: !spec ? 'not offered by this companion' : spec.available && spec.available.ok === false ? spec.available.why : !spatial(e) && e.states.installed.ok !== true ? e.states.installed.words : null };
  }));
  const cur = offered.find((o) => o.id === opId && !o.why) || null;
  useEffect(() => { if (cur) { setParams(Object.fromEntries(cur.spec.params.map((p) => [p.name, p.default]))); setInputs({}); } }, [opId]); // eslint-disable-line react-hooks/exhaustive-deps
  const delivered = files && files.ok ? [...new Set(files.results.flatMap((r) => (r.files || []).map((f) => f.path)).filter(Boolean))] : [];
  // follow the run as its record says (the app's own word), until it ended and its receipt was read
  useEffect(() => {
    if (!run || (TERMINAL.has(run.state) && (run.state !== 'completed' || run.collected))) return undefined;
    const t = setTimeout(async () => { const r = await getJson(`/api/workflow/runs/${run.id}${projectQuery()}`); if (alive.current && r.ok) setRun(r.run); }, 800);
    return () => clearTimeout(t);
  }, [run]);
  const go = async (e) => {
    e.preventDefault();
    if (!cur) return;
    setBusy(true); setNote('');
    const r = await postJson(`/api/workflow/runs${projectQuery()}`, { op: cur.id, inputs, params, board: 'control-room', node: `control:${cur.id}`, label: `${cur.label} (Control Room)` });
    setBusy(false);
    if (r.ok) setRun(r.run); else setNote(said(r));
  };
  const cancel = async () => { const r = await postJson(`/api/workflow/runs/${run.id}/cancel${projectQuery()}`, {}); if (r.ok) setRun(r.run); else setNote(said(r)); };
  const live = run && !TERMINAL.has(run.state);
  const rb = run && run.readback;
  return (
    <form className="tx-ctl-launch" onSubmit={go} aria-label="Run an app's operation through its adapter" data-ctl-app-op>
      <div className="tx-ctl-launch-row">
        <label className="tx-ctl-field"><span>Operation (from the integration catalog)</span>
          <select value={opId} onChange={(e) => { setOpId(e.target.value); setRun(null); setNote(''); }} data-ctl="operation">
            <option value="">Choose one…</option>
            {!answer ? <option disabled>Reading the catalog…</option> : offered.map((o) => <option key={o.id} value={o.id} disabled={Boolean(o.why)} data-op-available={o.why ? 'no' : 'yes'}>{o.app}: {o.label}{o.why ? ` — ${o.why}` : ''}</option>)}
          </select>
        </label>
      </div>
      {cur ? (
        <>
          <p className="ta-muted">{cur.spec.lead} Through: {cur.spec.adapter}.{cur.spec.heavy ? ` It ${cur.spec.heavy}.` : ''}</p>
          <div className="tx-ctl-launch-row">
            {cur.spec.inputs.map((p) => {
              const fit = delivered.filter((f) => p.accepts.includes(EXT(f)));
              return (
                <label key={p.name} className="tx-ctl-field"><span>{p.label} ({p.accepts.map((x) => `.${x}`).join(' ')})</span>
                  <select value={inputs[p.name] || ''} onChange={(e) => setInputs({ ...inputs, [p.name]: e.target.value })} data-ctl-input={p.name}>
                    <option value="">{fit.length ? 'Choose a delivered file…' : 'No delivered file fits'}</option>
                    {fit.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </label>
              );
            })}
            {cur.spec.params.map((p) => (
              <label key={p.name} className="tx-ctl-field tx-ctl-field-short"><span>{p.label}</span>
                {p.kind === 'choice' ? <select value={params[p.name]} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} data-ctl-param={p.name}>{p.choices.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                  : p.kind === 'number' ? <input type="number" min={p.min} max={p.max} value={params[p.name]} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} data-ctl-param={p.name} />
                    : <input value={params[p.name]} maxLength={p.maxLength} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} data-ctl-param={p.name} />}
              </label>
            ))}
          </div>
          <div className="ta-row">
            {live ? <Button onClick={cancel} data-ctl-op-cancel>Cancel</Button> : <Button kind="primary" type="submit" disabled={busy} data-ctl-op-run>{busy ? 'Checking…' : run ? 'Run again' : 'Run through its adapter'}</Button>}
            <span className="ta-muted">Checked first (inputs, parameters); then it is {appName(cur.spec.app)}’s own job.</span>
          </div>
        </>
      ) : null}
      {note ? <p className="ta-result" role="status">{note}</p> : null}
      {run ? (
        <div className="tx-ctl-op-run" data-ctl-op-state={run.state} data-ctl-readback={rb ? (rb.matched === rb.checked && rb.checked > 0 ? 'matched' : 'not-matched') : 'none'}>
          <p className="tx-ctl-row"><StateWord word={run.state} live={!TERMINAL.has(run.state)} /> <span className="ta-muted">{appName(run.app)} says {run.appWord || '…'}{run.progress != null ? ` · ${run.progress}%` : ''}</span></p>
          <Facts rows={[
            ['run', `${run.id} · attempt ${run.attempt}`],
            ['job', run.job || 'not started'],
            ...(run.error ? [['why', run.error]] : []),
            ...(run.receipts && run.receipts.length ? [['receipt', run.receipts.join(', ')]] : []),
            ...(rb ? [['read back', rb.checked ? `${rb.matched} of ${rb.checked} delivered file${rb.checked === 1 ? '' : 's'} read back from the project match their receipt${rb.missing.length ? `; missing: ${rb.missing.join(', ')}` : ''}${rb.mismatched.length ? `; different: ${rb.mismatched.join(', ')}` : ''}` : 'the receipt names no file']] : run.collected ? [['read back', run.collected]] : []),
          ]} />
          {run.outputs && run.outputs.length ? <ul className="tx-ctl-facts">{run.outputs.map((o) => <li key={o.path}><button type="button" className="ta-op-output" onClick={() => showInFiles(o.path)}>{o.path}</button> <code>{o.sha256.slice(0, 12)}</code></li>)}</ul> : null}
        </div>
      ) : null}
    </form>
  );
}

/** The canvas's selection as the target: the canvas agent, aimed from here (only the canvas page applies edits to its board). */
export function CanvasSelectionTarget() {
  const sel = useApp((s) => s.canvasSelection);
  const [goal, setGoal] = useState('');
  const nodes = sel ? sel.nodes : [];
  return (
    <div className="tx-ctl-launch" data-ctl-canvas>
      {nodes.length ? (
        <>
          <p className="ta-context-k">CHOSEN ON THE CANVAS · board {sel.board}</p>
          <ul className="tx-ctl-facts" data-ctl-canvas-nodes={nodes.length}>{nodes.map((n) => <li key={n.id}>{n.kind === 'operation' ? 'Operation' : 'File'}: {n.title}{n.path ? <span className="ta-muted"> · {n.path}</span> : null}</li>)}</ul>
          <label className="tx-ctl-field"><span>Goal for the canvas agent</span>
            <textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What the agent should do with these nodes" data-ctl-canvas-goal />
          </label>
          <div className="ta-row">
            <Button kind="primary" disabled={!goal.trim()} onClick={() => aimCanvasAgent({ goal, board: sel.board, nodes })} data-ctl-canvas-go>Open the canvas agent on them</Button>
            <span className="ta-muted">The canvas opens with its agent in Plan: nothing changes until you apply a plan there.</span>
          </div>
        </>
      ) : (
        <div className="ta-row"><p className="ta-muted" data-ctl-canvas-empty>Nothing is chosen on the canvas. Select files or operation nodes there, then come back.</p><Button onClick={() => goTo('canvas')}>Open the canvas</Button></div>
      )}
    </div>
  );
}
