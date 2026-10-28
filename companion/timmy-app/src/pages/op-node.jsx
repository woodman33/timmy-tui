// The unified Workspace order (2026-10-27): an executable operation node on the licensed tldraw canvas. Its operation (GET
// /api/workflow/operations: src/companion/workflow-ops.ts) declares typed input ports, parameters and outputs; the node
// connects each input to a compatible display node of the board with an EXECUTABLE edge (an arrow whose meta names the ports;
// an arrow a person draws stays a drawing), validates before it runs, and runs as the app's own durable job. Its native Rive
// console follows the run's own record (queued/running → working, held → awaiting, failed/interrupted → failed, cancelled →
// stopped, completed → idle; the exact word beside it); progress is a bar only where the app reports a number, otherwise an
// indeterminate activity line that never pretends to know. When the CURRENT attempt completes, each delivered file is
// attached to the board as a display node, connected from the operation's output; a superseded attempt never is.
// The canvas agent uses exactly these functions (planOps / applyOps below) under the same validation.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BaseBoxShapeUtil, HTMLContainer, T, createShapeId, resizeBox } from 'tldraw';
import { getJson, postJson } from '../api.js';
import { appName } from '../app-names.js';
import { MenuButton, MenuGroup, MenuItem, keepOut } from '../menu.jsx';
import { projectQuery, say, showInFiles, useApp } from '../store.js';
import { DISPLAY_SHAPE, KINDS, NODE_SIZE, displayKindOf } from './display-node.jsx';
import { placeOnBoard } from './canvas-import.jsx';

export const OP_SHAPE = 'timmy-op';
const stopAll = { ...keepOut, onKeyDown: (e) => e.stopPropagation() };
const TERMINAL = new Set(['failed', 'cancelled', 'completed', 'interrupted']);
const FACE_WORD = { queued: 'working', running: 'working', held: 'awaiting', failed: 'failed', interrupted: 'failed', cancelled: 'stopped', completed: 'idle' };

let ops = null;
/** The operations this companion offers (read once per page). */
export function operations() {
  if (!ops) { ops = getJson(`/api/workflow/operations${projectQuery()}`).then((r) => (r.ok ? r.operations : []), () => []); ops.then((x) => { if (!x.length) ops = null; }); }
  return ops;
}
const parse = (s, d) => { try { const v = JSON.parse(s || ''); return v && typeof v === 'object' ? v : d; } catch { return d; } };
const EXT = (p) => (/\.([a-z0-9]+)$/i.exec(String(p || '')) || [])[1]?.toLowerCase() || '';
/** Whether a display node can feed a port (its file's extension among the port's). */
export const feeds = (port, shape) => Boolean(shape && shape.type === DISPLAY_SHAPE && port.accepts.includes(EXT(shape.props.path)));

// ── the graph operations (a person's presses and the agent's plan both go through these) ───────────────────────────────

/** An executable edge: an arrow bound from a source node to the operation node, its meta naming the port (one per port). */
export function connectPort(editor, opId, port, sourceId) {
  const op = editor.getShape(opId); const src = editor.getShape(sourceId);
  if (!op || !src) return { ok: false, why: 'one of the two nodes is not on this board' };
  const spec = parse(op.props.spec, null);
  const p = spec && spec.inputs.find((x) => x.name === port);
  if (!p) return { ok: false, why: `${spec ? spec.label : 'This operation'} has no input ${port}` };
  if (!feeds(p, src)) return { ok: false, why: `${src.props.title || 'that node'} is not one of ${p.accepts.map((x) => `.${x}`).join(', ')}` };
  const inputs = parse(op.props.inputs, {});
  editor.run(() => {
    // the port's earlier edge is replaced
    for (const s of editor.getCurrentPageShapes()) if (s.type === 'arrow' && s.meta && s.meta.edge === 'timmy' && s.meta.to === opId && s.meta.port === port) editor.deleteShape(s.id);
    const a = editor.getShapePageBounds(sourceId); const b = editor.getShapePageBounds(opId);
    const id = createShapeId();
    const start = { x: a.x + a.w, y: a.y + a.h / 2 }; const end = { x: b.x, y: b.y + 40 };
    editor.createShape({ id, type: 'arrow', x: start.x, y: start.y, meta: { edge: 'timmy', from: sourceId, to: opId, port, type: p.type }, props: { start: { x: 0, y: 0 }, end: { x: end.x - start.x, y: end.y - start.y }, size: 's', color: 'light-blue', arrowheadEnd: 'arrow' } });
    const at = (terminal, toId) => ({ type: 'arrow', fromId: id, toId, props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } });
    editor.createBindings([at('start', sourceId), at('end', opId)]);
    editor.updateShape({ id: opId, type: OP_SHAPE, props: { inputs: JSON.stringify({ ...inputs, [port]: { node: sourceId, path: src.props.path, title: src.props.title } }) } });
  });
  return { ok: true };
}

/** A new operation node where the board has room (or at `at`); `meta` marks who made it (the agent: { by: 'agent', plan }). */
export function addOperationNode(editor, spec, at = null, meta = null) {
  const id = createShapeId();
  const defaults = Object.fromEntries(spec.params.map((p) => [p.name, p.default]));
  const p = at || placeOnBoard(editor, 380, 420);
  editor.run(() => {
    editor.createShape({ id, type: OP_SHAPE, x: p.x, y: p.y, ...(meta ? { meta } : {}), props: { w: 380, h: 420, op: spec.id, spec: JSON.stringify(spec), title: spec.label, inputs: '{}', params: JSON.stringify(defaults), run: '', applied: '', panel: true } });
    editor.select(id);
  });
  return id;
}

/** One parameter of an operation node set (the value checked by the companion when the node is validated or run). */
export function setNodeParam(editor, id, name, value) {
  const op = editor.getShape(id);
  if (!op || op.type !== OP_SHAPE) return { ok: false, why: 'not an operation node on this board' };
  const spec = parse(op.props.spec, null);
  if (!spec || !spec.params.some((x) => x.name === name)) return { ok: false, why: `${spec ? spec.label : 'This operation'} has no parameter ${name}` };
  editor.updateShape({ id, type: OP_SHAPE, props: { params: JSON.stringify({ ...parse(op.props.params, {}), [name]: value }) } });
  return { ok: true };
}

/** The board's executable edges from a node (what it feeds), for the agent's plan and the inspector. */
export function edgesOf(editor) {
  return editor.getCurrentPageShapes().filter((s) => s.type === 'arrow' && s.meta && s.meta.edge === 'timmy').map((s) => ({ id: s.id, from: s.meta.from, to: s.meta.to, port: s.meta.port, type: s.meta.type }));
}

/** Validates an operation node's inputs and parameters on the companion (nothing starts). */
export async function validateNode(shape) {
  const inputs = Object.fromEntries(Object.entries(parse(shape.props.inputs, {})).map(([k, v]) => [k, v.path]));
  return postJson(`/api/workflow/validate${projectQuery()}`, { op: shape.props.op, inputs, params: parse(shape.props.params, {}) });
}

/** Runs an operation node (validated first by the companion): the run becomes the node's current attempt. */
export async function runNode(editor, shape, board, by = 'person') {
  const inputs = Object.fromEntries(Object.entries(parse(shape.props.inputs, {})).map(([k, v]) => [k, v.path]));
  const r = await postJson(`/api/workflow/runs${projectQuery()}`, { op: shape.props.op, inputs, params: parse(shape.props.params, {}), board, node: shape.id, label: shape.props.title, by });
  if (r.ok) editor.updateShape({ id: shape.id, type: OP_SHAPE, props: { run: r.run.id } });
  return r;
}

/** The current attempt's delivered files, attached to the board as display nodes, connected from the operation (once per run). */
export function attachOutputs(editor, shape, run) {
  if (!run || !run.current || run.id !== shape.props.run || shape.props.applied === run.id || run.state !== 'completed') return [];
  const b = editor.getShapePageBounds(shape.id);
  const files = run.outputs.filter((o) => !/manifest\.json$/.test(o.path));
  const made = [];
  editor.run(() => {
    for (const o of files) {
      const kind = displayKindOf(o.path);
      const [w, h] = NODE_SIZE[kind] || NODE_SIZE.file;
      const id = createShapeId();
      const q = placeOnBoard(editor, w, h, null, null, { x: b.x + b.w + 80, y: b.y });
      const y = q.y;
      editor.createShape({ id, type: DISPLAY_SHAPE, x: q.x, y, meta: { from: 'app-output', app: run.app, path: o.path, receipt: run.receipts[run.receipts.length - 1] || null, run: run.id }, props: { w, h, kind, title: o.path.split('/').pop(), path: o.path, app: run.app, receipt: run.receipts[run.receipts.length - 1] || '', job: run.job || '', mode: (KINDS[kind] || KINDS.file).modes[0][0], panel: false } });
      const a = createShapeId();
      editor.createShape({ id: a, type: 'arrow', x: b.x + b.w, y: b.y + 40, meta: { edge: 'timmy', from: shape.id, to: id, port: 'output', type: kind }, props: { start: { x: 0, y: 0 }, end: { x: q.x - (b.x + b.w), y: y - b.y }, size: 's', color: 'light-blue', arrowheadEnd: 'arrow' } });
      const at = (terminal, toId) => ({ type: 'arrow', fromId: a, toId, props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } });
      editor.createBindings([at('start', shape.id), at('end', id)]);
      made.push(id);
    }
    editor.updateShape({ id: shape.id, type: OP_SHAPE, props: { applied: run.id } });
  });
  return made;
}

// ── the node's parts ────────────────────────────────────────────────────────────────────────────────────────────────────

function OpFace({ id, state, theme }) {
  const ref = useRef(null); const handle = useRef(null);
  useEffect(() => {
    const R = window.TimmyRive; const host = ref.current;
    if (!R || !host) return undefined;
    host.replaceChildren();
    const h = R.mountConsole(host, { name: `op:${id}`, binds: [`job:op-${id}`], size: 'card', place: 'app', heading: null, word: FACE_WORD[state] || 'idle', words: 'spoken', theme, label: 'Operation' });
    handle.current = h;
    return () => { handle.current = null; try { h.unmount(); } catch { /* gone */ } };
  }, [id, theme]);
  useEffect(() => { const R = window.TimmyRive; if (R && R.fromJob && handle.current) try { R.fromJob(handle.current, FACE_WORD[state] || 'idle', `GET /api/workflow/runs (the run's record: ${state || 'not run'})`, TERMINAL.has(state)); } catch { /* the word stays */ } }, [state]);
  return <div ref={ref} className="ta-face ta-face-console ta-op-face" data-face="op" data-state={state || 'idle'} />;
}

function Progress({ run }) {
  if (!run || TERMINAL.has(run.state)) return null;
  if (typeof run.progress === 'number') return <div className="ta-op-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.progress} aria-label="Progress, as the app reports it"><i style={{ width: `${run.progress}%` }} /></div>;
  return <div className="ta-op-bar is-unknown" role="progressbar" aria-busy="true" aria-label="Working: the app does not report how far it is"><i /></div>;
}

function Ports({ editor, shape, spec }) {
  const inputs = parse(shape.props.inputs, {});
  return (
    <ul className="ta-op-ports" aria-label="Inputs">
      {spec.inputs.map((p) => {
        const got = inputs[p.name];
        const sources = editor.getCurrentPageShapes().filter((s) => feeds(p, s));
        return (
          <li key={p.name} className="ta-op-port" data-port={p.name} data-connected={got ? 'yes' : 'no'}>
            <span className="ta-op-port-name">{p.label}<small>{p.accepts.map((x) => `.${x}`).join(' ')}{p.required ? '' : ' · optional'}</small></span>
            <MenuButton label={got ? got.title : 'Connect…'} title={`Connect ${p.label}`} menuLabel={`${p.label}: connect a node`} buttonClass="ta-node-btn" data={{ 'data-menu': 'op-port', 'data-port': p.name }}>
              {(close) => (
                <MenuGroup label={`Nodes that can feed ${p.label}`}>
                  {sources.length ? sources.map((s) => <MenuItem key={s.id} close={close} checked={Boolean(got && got.node === s.id)} hint={s.props.path} data={{ 'data-source': s.props.path }} onSelect={() => { const r = connectPort(editor, shape.id, p.name, s.id); if (!r.ok) say(`Not connected: ${r.why}.`); }}>{s.props.title}</MenuItem>)
                    : <p className="ta-menu-note">No node on this board is one of {p.accepts.map((x) => `.${x}`).join(', ')}. Import one from an app first.</p>}
                </MenuGroup>
              )}
            </MenuButton>
          </li>
        );
      })}
    </ul>
  );
}

function Params({ editor, shape, spec, disabled }) {
  const values = parse(shape.props.params, {});
  const set = (k, v) => editor.updateShape({ id: shape.id, type: OP_SHAPE, props: { params: JSON.stringify({ ...values, [k]: v }) } });
  if (!spec.params.length) return <p className="ta-node-fact">No parameters.</p>;
  return (
    <div className="ta-op-params" {...stopAll}>
      {spec.params.map((p) => (
        <label key={p.name} className="ta-op-param">
          <span>{p.label}</span>
          {p.kind === 'choice' ? <select value={values[p.name] ?? p.default} disabled={disabled} onChange={(e) => set(p.name, e.target.value)} data-param={p.name}>{p.choices.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            : p.kind === 'number' ? <input type="number" min={p.min} max={p.max} value={values[p.name] ?? p.default} disabled={disabled} onChange={(e) => set(p.name, Number(e.target.value))} data-param={p.name} />
              : <input type="text" maxLength={p.maxLength} value={values[p.name] ?? p.default} disabled={disabled} onChange={(e) => set(p.name, e.target.value)} data-param={p.name} />}
        </label>
      ))}
    </div>
  );
}

function OpNode({ shape, editor, board, focus }) {
  const spec = useMemo(() => parse(shape.props.spec, null), [shape.props.spec]);
  const [run, setRun] = useState(null);
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(false);
  const theme = useApp((st) => st.theme);
  // the current attempt, followed while it runs (its record is the truth; the page never advances it)
  useEffect(() => {
    if (!shape.props.run) { setRun(null); return undefined; }
    let gone = false; let t = 0;
    const read = async () => {
      const r = await getJson(`/api/workflow/runs/${shape.props.run}${projectQuery()}`);
      if (gone) return;
      if (r.ok) {
        setRun(r.run);
        // followed while it runs, and while a completed run's files are being collected
        if (!r.run.terminal || (r.run.state === 'completed' && !r.run.collected)) t = setTimeout(read, 700);
        else attachOutputs(editor, editor.getShape(shape.id) || shape, r.run);
      }
      else setRun({ id: shape.props.run, state: 'unknown', error: r.error });
    };
    read();
    return () => { gone = true; clearTimeout(t); };
  }, [shape.props.run]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!spec) return <div className="ta-node"><p className="ta-node-wait">This operation is not known to this Timmy.</p></div>;
  const state = run ? run.state : '';
  const live = run && !run.terminal;
  const word = !run ? 'not run' : run.left ? 'left by an earlier Timmy' : state === 'completed' && !run.collected ? 'collecting' : state;
  const doRun = async () => {
    setBusy(true); setProblems([]);
    const v = await validateNode(shape);
    if (!v.ok) { setProblems(v.problems || [v.error || 'Not valid.']); setBusy(false); return; }
    const r = await runNode(editor, shape, board);
    setBusy(false);
    if (!r.ok) setProblems(r.problems || [r.error || `The companion answered ${r.status}.`]);
  };
  const cancel = async () => { const r = await postJson(`/api/workflow/runs/${run.id}/cancel${projectQuery()}`, {}); if (!r.ok) say(`Not cancelled: ${r.error}`); else setRun(r.run); };
  const recover = async () => { const r = await postJson(`/api/workflow/runs/${run.id}/recover${projectQuery()}`, {}); if (!r.ok) say(`Not recovered: ${r.error}`); else { setRun(r.run); editor.updateShape({ id: shape.id, type: OP_SHAPE, props: { run: '' } }); editor.updateShape({ id: shape.id, type: OP_SHAPE, props: { run: r.run.id } }); } };
  return (
    <div className="ta-node ta-op" data-op={shape.props.op} data-op-state={state || 'idle'}>
      <header className="ta-node-head">
        <span className="ta-node-kind">OPERATION</span>
        {shape.meta && shape.meta.by === 'agent' ? <span className="ta-node-by" data-op-by="agent" title={`Added by the canvas agent (plan ${shape.meta.plan || ''})`}>AGENT</span> : null}
        <strong className="ta-node-title" title={spec.lead}>{shape.props.title}</strong>
        <span className="ta-node-status" data-op-word>{word}</span>
        <MenuButton label="Actions" glyph="⋯" title="Actions" menuLabel={`${shape.props.title}: actions`} buttonClass="ta-node-btn is-icon" data={{ 'data-menu': 'op-actions' }}>
          {(close) => (
            <>
              <MenuGroup label="This operation">
                <MenuItem close={close} disabled={busy || live} onSelect={doRun} data={{ 'data-act': 'run' }} hint={spec.heavy ? `It ${spec.heavy}.` : undefined}>Run</MenuItem>
                <MenuItem close={close} disabled={!live || (run && run.left)} onSelect={cancel} data={{ 'data-act': 'cancel' }}>Cancel</MenuItem>
                <MenuItem close={close} disabled={!run || !run.left} onSelect={recover} data={{ 'data-act': 'recover' }}>Recover</MenuItem>
                <MenuItem close={close} onSelect={() => editor.updateShape({ id: shape.id, type: OP_SHAPE, props: { panel: !shape.props.panel } })} data={{ 'data-act': 'inspector' }}>{shape.props.panel ? 'Hide the parameters' : 'Show the parameters'}</MenuItem>
              </MenuGroup>
              <MenuGroup label="Canvas"><MenuItem close={close} onSelect={() => editor.deleteShape(shape.id)} data={{ 'data-act': 'delete' }}>Remove from this board</MenuItem></MenuGroup>
            </>
          )}
        </MenuButton>
      </header>
      <div className="ta-op-body" {...stopAll}>
        <div className="ta-op-live"><OpFace id={shape.id} state={state} theme={theme} /><Progress run={run} /></div>
        <Ports editor={editor} shape={shape} spec={spec} />
        {shape.props.panel ? <Params editor={editor} shape={shape} spec={spec} disabled={busy || live} /> : null}
        {problems.length ? <ul className="ta-op-problems" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
        {run ? (
          <dl className="ta-facts ta-op-facts" data-op-run-id={run.id}>
            <dt>Run</dt><dd><code>{run.id}</code> · attempt {run.attempt}{run.current ? '' : ' (superseded)'}</dd>
            <dt>{appName(spec.app)}</dt><dd>{run.job ? <>job <code>{run.job}</code> · the app says {run.appWord || '…'}</> : 'no job yet'}</dd>
            {run.error ? <><dt>Why</dt><dd>{run.error}</dd></> : null}
            {run.receipts && run.receipts.length ? <><dt>Receipt</dt><dd data-op-receipt>{run.receipts.map((r) => <code key={r}>{r}</code>)}</dd></> : null}
            {run.outputs && run.outputs.length ? <><dt>Outputs</dt><dd data-op-outputs>{run.outputs.map((o) => {
              // a result on the board is brought into view; one not on it (a cancelled or older attempt's, a manifest) opens in Files
              const node = editor ? editor.getCurrentPageShapes().find((x) => x.type === DISPLAY_SHAPE && x.meta && x.meta.run === run.id && x.props.path === o.path) : null;
              const name = o.path.split('/').pop();
              return <button key={o.path} type="button" className="ta-linkbtn ta-op-output" data-op-output={o.path} onClick={() => (node && focus ? focus(editor, node.id) : showInFiles(o.path))} title={node ? `Show ${name} on the board` : `Show ${name} in Files`}>{name}</button>;
            })}</dd></> : null}
            {run.readback ? <><dt>Read back</dt><dd data-op-readback={run.readback.checked && run.readback.matched === run.readback.checked ? 'matched' : 'not-matched'}>{run.readback.checked ? `${run.readback.matched} of ${run.readback.checked} match their receipt` : 'the receipt names no file'}{run.readback.missing.length ? ` · missing ${run.readback.missing.length}` : ''}{run.readback.mismatched.length ? ` · different ${run.readback.mismatched.length}` : ''}</dd></> : null}
          </dl>
        ) : <p className="ta-node-fact">{spec.lead}</p>}
      </div>
      <footer className="ta-node-foot" {...stopAll}>
        {live && !run.left ? <button type="button" className="ta-btn ta-node-primary" onClick={cancel} data-node-primary data-op-cancel>Cancel</button>
          : run && run.left ? <button type="button" className="ta-btn ta-btn-primary ta-node-primary" onClick={recover} data-node-primary data-op-recover>Recover</button>
            : <button type="button" className="ta-btn ta-btn-primary ta-node-primary" disabled={busy} onClick={doRun} data-node-primary data-op-run>{busy ? 'Checking…' : run ? 'Run again' : 'Run'}</button>}
        <span className="ta-node-fact">{appName(spec.app)}{spec.heavy ? ` · ${spec.heavy}` : ''}</span>
      </footer>
    </div>
  );
}

/** The operation node's shape. `boardOf` names the board it is on (a run records it); `focus` brings a node into view. */
export function createOpUtil(editorOf, boardOf, focus = null) {
  return class OpUtil extends BaseBoxShapeUtil {
    static type = OP_SHAPE;
    static props = { w: T.number, h: T.number, op: T.string, spec: T.string, title: T.string, inputs: T.string, params: T.string, run: T.string, applied: T.string, panel: T.boolean };
    getDefaultProps() { return { w: 380, h: 420, op: '', spec: '', title: 'Operation', inputs: '{}', params: '{}', run: '', applied: '', panel: true }; }
    hideRotateHandle() { return true; }
    canEdit() { return false; }
    canBind() { return true; }
    onResize(shape, info) { const n = resizeBox(shape, info); return { ...n, props: { ...n.props, w: Math.max(300, n.props.w), h: Math.max(260, n.props.h) } }; }
    getText(shape) { return shape.props.title; }
    component(shape) {
      return <HTMLContainer className="ta-node-shape" style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}><OpNode shape={shape} editor={editorOf()} board={boardOf()} focus={focus} /></HTMLContainer>;
    }
    getIndicatorPath(shape) { const p = new Path2D(); p.roundRect(0, 0, shape.props.w, shape.props.h, 14); return p; }
  };
}
