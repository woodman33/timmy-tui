// The unified Workspace order (2026-10-27): the canvas agent's panel, a layer on the stage beside the inspector. The person
// names a goal; the agent (src/companion/canvas-agent.ts: the project's chat model, in this computer's Ollama only) answers
// with a plan in the board's own operations, and this panel applies it through the SAME functions a person's presses use
// (./op-node.jsx addOperationNode, connectPort, setNodeParam, runNode with by 'agent'), one step at a time, visibly.
//
//   Plan       the agent proposes; nothing changes until the person presses Apply edits (or Apply and run)
//   Run        the agent proposes and the plan is applied at once, its runs started (one round)
//   Autopilot  as Run, then, when its runs have ended and the agent did not say it is done, it is asked again with what
//              happened, within the budget (steps, runs, rounds); Stop ends it at any point
//
// The target is the selection (its files and operation nodes) or, with nothing selected, the whole board. Stop abandons the
// model's answer if it has not come, applies nothing more, and asks the app to cancel every run this agent started that is
// still going.

import { useEffect, useRef, useState } from 'react';
import { useValue } from 'tldraw';
import { call, getJson, postJson } from '../api.js';
import { projectQuery, takeCanvasAim } from '../store.js';
import { keepKeys, keepPointer } from '../ui.jsx';
import { DISPLAY_SHAPE } from './display-node.jsx';
import { OP_SHAPE, addOperationNode, connectPort, operations, runNode, setNodeParam } from './op-node.jsx';

const MODES = [['plan', 'Plan', 'The agent proposes; you apply.'], ['run', 'Run', 'The plan is applied and run at once.'], ['autopilot', 'Autopilot', 'Applied, run, and asked again within the budget.']];
const TERMINAL = new Set(['failed', 'cancelled', 'completed', 'interrupted']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LAYER_KEY = 'timmy-app:agent-layer';
const readFold = () => { try { return localStorage.getItem(LAYER_KEY) !== 'open'; } catch { return true; } };
const keepFold = (folded) => { try { localStorage.setItem(LAYER_KEY, folded ? 'folded' : 'open'); } catch { /* not kept */ } };

/** The selection the agent is pointed at: its files and operation nodes (other shapes are not the agent's to name). */
function targetOf(editor) {
  if (!editor) return [];
  return editor.getSelectedShapes().filter((s) => s.type === DISPLAY_SHAPE || s.type === OP_SHAPE).map((s) => ({ id: s.id, title: s.props.title || s.props.path || s.props.op }));
}

export function AgentLayer({ editor, board, settle }) {
  const [folded, setFolded] = useState(readFold);
  const [harness, setHarness] = useState(null);
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState('plan');
  const [budget, setBudget] = useState({ steps: 8, runs: 1, rounds: 2 });
  const [phase, setPhase] = useState('idle'); // idle · asking · proposed · applying · waiting · done · stopped · refused
  const [plan, setPlan] = useState(null);
  const [words, setWords] = useState('');
  const [log, setLog] = useState([]);
  const stop = useRef(null);
  const started = useRef([]);
  const target = useValue('timmy agent: target', () => (editor ? targetOf(editor).map((t) => `${t.id}\u0000${t.title}`).join('\u0001') : ''), [editor]);
  const chosen = target ? target.split('\u0001').map((x) => { const [id, title] = x.split('\u0000'); return { id, title }; }) : [];
  useEffect(() => { getJson(`/api/canvas-agent/harness${projectQuery()}`).then((r) => setHarness(r.ok ? r.harness : { ready: false, label: 'Agent off', words: r.error || 'The companion did not answer.' })); }, []);
  // aimed from the Control Room ("the canvas selection"): the panel opens with the goal, in Plan, its nodes chosen again
  useEffect(() => {
    if (!editor) return;
    const aim = takeCanvasAim();
    if (!aim || (aim.board && aim.board !== board)) return;
    const there = aim.nodes.filter((id) => editor.getShape(id));
    if (there.length) editor.select(...there);
    setGoal(aim.goal); setMode('plan'); setFolded(false); keepFold(false);
    setWords(there.length < aim.nodes.length ? `${aim.nodes.length - there.length} of the chosen nodes are no longer on this board.` : 'Aimed from the Control Room: review the goal, then Plan.');
  }, [editor, board]);
  const toggle = () => { const f = !folded; setFolded(f); keepFold(f); };
  const note = (line) => setLog((l) => [...l, line].slice(-40));
  const busy = phase === 'asking' || phase === 'applying' || phase === 'waiting';

  /** One plan asked of the agent (the board saved first, so the agent reads what the person sees). */
  const ask = async (previous = null) => {
    const ctl = new AbortController();
    stop.current = { ctl, plan: null };
    setPhase('asking'); setWords(previous ? 'Asking the agent again with what happened…' : 'Asking the agent…');
    const revision = settle ? await settle() : null;
    let r;
    try {
      const res = await call(`/api/canvas-agent/plan${projectQuery()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ board, goal, mode, budget, selection: chosen.map((c) => c.id), ...(Number.isInteger(revision) ? { revision } : {}), ...(previous ? { previous } : {}) }) });
      r = await res.json().catch(() => ({ ok: false, error: `The companion answered ${res.status}.` }));
    } catch (e) {
      if (ctl.signal.aborted) return null;
      r = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (ctl.signal.aborted) return null;
    if (r.plan) setPlan(r.plan);
    if (!r.ok) { setPhase('refused'); setWords(r.error || 'The agent refused.'); note(`Refused: ${r.error || ''}`); return null; }
    stop.current.plan = r.plan.id;
    note(`Plan ${r.plan.id}: ${r.plan.steps.length} step${r.plan.steps.length === 1 ? '' : 's'}${r.plan.say ? ` — ${r.plan.say}` : ''}`);
    return r.plan;
  };

  /** A plan applied through the person's own graph functions, one visible step at a time. `withRuns` false leaves its runs. */
  const apply = async (p, withRuns) => {
    setPhase('applying'); setWords('Applying the plan on the board…');
    const specs = await operations();
    const refs = {};
    const nodeOf = (n) => (refs[n] || n);
    const runs = [];
    for (const s of p.steps) {
      if (stop.current && stop.current.stopped) return runs;
      let out = { ok: true }; let shape; let run;
      if (s.do === 'add') {
        const spec = specs.find((o) => o.id === s.operation);
        if (!spec) out = { ok: false, why: `this page does not offer ${s.operation}` };
        else { shape = addOperationNode(editor, spec, null, { by: 'agent', plan: p.id }); refs[s.ref] = shape; }
      } else if (s.do === 'connect') out = connectPort(editor, nodeOf(s.node), s.port, s.from);
      else if (s.do === 'set') out = setNodeParam(editor, nodeOf(s.node), s.param, s.value);
      else if (s.do === 'run') {
        if (!withRuns) { note(`Step ${s.n} left for you: ${s.words}`); continue; }
        const node = editor.getShape(nodeOf(s.node));
        const r = node ? await runNode(editor, node, board, 'agent') : { ok: false, error: 'the node is not on this board' };
        if (r.ok) { run = r.run.id; runs.push(run); started.current.push(run); } else out = { ok: false, why: (r.problems || [r.error]).join(' ') };
      }
      if (!out.ok) { note(`Step ${s.n} not applied: ${out.why}`); setWords(`Step ${s.n} could not be applied: ${out.why}. The rest of the plan is not applied.`); setPhase('stopped'); await postJson(`/api/canvas-agent/plans/${p.id}/stop${projectQuery()}`, {}); return null; }
      const kept = await postJson(`/api/canvas-agent/plans/${p.id}/applied${projectQuery()}`, { n: s.n, ...(shape ? { shape } : {}), ...(run ? { run } : {}), words: s.words });
      if (kept.ok) setPlan(kept.plan);
      note(`Step ${s.n}: ${s.words}`);
      await wait(250);
    }
    return runs;
  };

  /** Waits for the runs this round started to end (each as the app says); what happened, in words for the next round. */
  const follow = async (runs) => {
    if (!runs.length) return [];
    setPhase('waiting'); setWords(`Waiting for ${runs.length} run${runs.length === 1 ? '' : 's'} to end…`);
    const end = Date.now() + 10 * 60_000;
    const out = {};
    while (Date.now() < end) {
      if (stop.current && stop.current.stopped) break;
      for (const id of runs) {
        if (out[id] && TERMINAL.has(out[id].state) && (out[id].state !== 'completed' || out[id].collected)) continue;
        const r = await getJson(`/api/workflow/runs/${id}${projectQuery()}`);
        if (r.ok) out[id] = r.run;
      }
      if (runs.every((id) => out[id] && TERMINAL.has(out[id].state) && (out[id].state !== 'completed' || out[id].collected))) break;
      await wait(800);
    }
    return runs.map((id) => (out[id] ? `run ${id} ${out[id].state}${out[id].error ? ` (${out[id].error})` : ''}${out[id].outputs && out[id].outputs.length ? `, ${out[id].outputs.length} file(s) on the board` : ''}` : `run ${id}: not read`));
  };

  const go = async () => {
    if (!editor || !goal.trim()) return;
    setLog([]); started.current = [];
    let p = await ask();
    if (!p) return;
    if (mode === 'plan') { setPhase('proposed'); setWords(p.steps.length ? 'Proposed. Nothing on the board has changed: apply it, or discard it.' : (p.say || 'The agent proposes nothing.')); return; }
    for (let round = 1; p; round++) {
      const runs = await apply(p, true);
      if (runs === null) return;
      const outcomes = await follow(runs);
      outcomes.forEach((o) => note(o));
      if (stop.current && stop.current.stopped) return;
      if (mode !== 'autopilot' || p.done || !p.steps.length || round >= budget.rounds) break;
      p = await ask(p.id);
    }
    setPhase('done'); setWords(p && p.done ? 'The agent says the board does what you asked.' : 'Done: the plan is applied.');
  };
  const applyProposed = async (withRuns) => {
    if (!plan) return;
    stop.current = { plan: plan.id };
    const runs = await apply(plan, withRuns);
    if (runs === null) return;
    (await follow(runs)).forEach((o) => note(o));
    if (!(stop.current && stop.current.stopped)) { setPhase('done'); setWords('Applied.'); }
  };
  const discard = async () => { if (plan) await postJson(`/api/canvas-agent/plans/${plan.id}/stop${projectQuery()}`, {}); setPhase('idle'); setPlan(null); setWords('Discarded: nothing was applied.'); };
  const halt = async () => {
    const s = stop.current || {};
    s.stopped = true; stop.current = s;
    if (s.ctl) s.ctl.abort();
    const id = s.plan || (plan && plan.id);
    if (id) await postJson(`/api/canvas-agent/plans/${id}/stop${projectQuery()}`, {});
    let n = 0;
    for (const run of started.current) {
      const r = await postJson(`/api/workflow/runs/${run}/cancel${projectQuery()}`, {});
      if (r.ok) n += 1;
    }
    setPhase('stopped'); setWords(`Stopped: nothing more is applied${n ? `, and ${n} run${n === 1 ? '' : 's'} the agent started ${n === 1 ? 'was' : 'were'} asked to cancel` : ''}.`);
    note('Stopped by you.');
  };

  const ready = Boolean(harness && harness.ready);
  return (
    <section className={`ta-layer ta-agent-layer${folded ? ' is-folded' : ''}`} aria-label="Agent" data-agent-phase={phase} onPointerDown={keepPointer} {...keepKeys}>
      <header className="ta-layer-head is-static">
        <span className="ta-layer-grip" aria-hidden="true">✦</span>
        <span className="ta-layer-title">Agent</span>
        {busy ? <span className="ta-layer-flag">working</span> : null}
        <button type="button" className="ta-layer-fold" aria-expanded={!folded} aria-label={folded ? 'Open the agent' : 'Fold the agent'} onClick={toggle} data-agent-toggle><span aria-hidden="true">▾</span></button>
      </header>
      <div className="ta-layer-body" aria-hidden={folded ? 'true' : undefined} inert={folded}>
        <p className={`ta-agent-harness${ready ? '' : ' is-off'}`} data-agent-harness={ready ? 'ready' : 'off'} title={harness ? harness.words : ''}>{harness ? harness.label : 'Reading the agent’s harness…'}</p>
        {harness && !ready ? <p className="ta-muted ta-agent-why" data-agent-why>{harness.words}</p> : null}
        <p className="ta-context-k">TARGET</p>
        <p className="ta-agent-target" data-agent-target={chosen.length ? 'selection' : 'board'}>{chosen.length ? `${chosen.length} selected: ${chosen.map((c) => c.title).join(', ').slice(0, 120)}` : 'The whole board (select nodes to narrow it)'}</p>
        <label className="ta-context-k" htmlFor="ta-agent-goal">GOAL</label>
        <textarea id="ta-agent-goal" className="ta-agent-goal" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Animate the card image with a pulse and export an HTML player" disabled={busy} data-agent-goal />
        <div className="ta-agent-modes" role="radiogroup" aria-label="How the agent works">
          {MODES.map(([id, label, hint]) => (
            <label key={id} className={`ta-agent-mode${mode === id ? ' is-on' : ''}`} title={hint}>
              <input type="radio" name="ta-agent-mode" value={id} checked={mode === id} onChange={() => setMode(id)} disabled={busy} data-agent-mode={id} />{label}
            </label>
          ))}
        </div>
        {mode === 'autopilot' ? (
          <div className="ta-agent-budget" data-agent-budget>
            {[['steps', 'Steps', 1, 9], ['runs', 'Runs', 0, 3], ['rounds', 'Rounds', 1, 4]].map(([k, label, lo, hi]) => (
              <label key={k}>{label}<input type="number" min={lo} max={hi} value={budget[k]} disabled={busy} onChange={(e) => setBudget({ ...budget, [k]: Math.max(lo, Math.min(hi, Number(e.target.value) || lo)) })} data-agent-budget-k={k} /></label>
            ))}
          </div>
        ) : null}
        <div className="ta-agent-actions">
          {busy ? <button type="button" className="ta-btn" onClick={halt} data-agent-stop>Stop</button>
            : <button type="button" className="ta-btn ta-btn-primary" onClick={go} disabled={!ready || !goal.trim() || !editor} data-agent-go>{mode === 'plan' ? 'Plan' : mode === 'run' ? 'Plan and run' : 'Start autopilot'}</button>}
          {phase === 'proposed' && plan && plan.steps.length ? (
            <>
              <button type="button" className="ta-btn" onClick={() => applyProposed(false)} data-agent-apply>Apply edits</button>
              <button type="button" className="ta-btn" onClick={() => applyProposed(true)} data-agent-apply-run>Apply and run</button>
              <button type="button" className="ta-btn" onClick={discard} data-agent-discard>Discard</button>
            </>
          ) : null}
        </div>
        {words ? <p className="ta-agent-words" role="status" data-agent-words>{words}</p> : null}
        {plan ? (
          <div className="ta-agent-plan" data-agent-plan={plan.id} data-agent-plan-state={plan.state}>
            <p className="ta-context-k">PLAN · {plan.harness.model || plan.harness.kind} · board revision {plan.boardRevision}</p>
            {plan.say ? <p className="ta-agent-say">{plan.say}</p> : null}
            {plan.steps.length ? (
              <ol className="ta-agent-steps">
                {plan.steps.map((s) => <li key={s.n} data-agent-step={s.n} data-applied={plan.applied.some((a) => a.n === s.n) ? 'yes' : 'no'}>{s.words}</li>)}
              </ol>
            ) : null}
            {plan.problems.length ? <ul className="ta-agent-problems" data-agent-problems>{plan.problems.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
            {plan.raw ? <p className="ta-muted ta-agent-raw" title="The model's answer as it came (sha256)">answer <code>{plan.raw.sha256.slice(0, 12)}</code>{plan.model && plan.model.ms != null ? ` · ${(plan.model.ms / 1000).toFixed(1)} s` : ''}{plan.model && plan.model.evalCount != null ? ` · ${plan.model.evalCount} tokens` : ''}</p> : null}
          </div>
        ) : null}
        {log.length ? <ol className="ta-agent-log" aria-label="What the agent did" data-agent-log>{log.map((l, i) => <li key={i}>{l}</li>)}</ol> : null}
      </div>
    </section>
  );
}
