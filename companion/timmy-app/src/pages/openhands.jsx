// The 07:37 completion pass, on the operator's 07:57 word: the OpenHands sandbox, its own rail entry under AGENTS. It is the
// Control Room's AGENT RUNS kept to the OpenHands harness (the same /api/control/* routes and `timmy act`: a disposable copy
// of the project, a run on a model of this computer, Stop and Recover, the changed files and the receipt), with its setup
// here read from GET /api/control/harnesses. No parallel engine: nothing on this page starts anything the Control Room does
// not. Two OpenHands paths exist in Timmy and the page names both, so neither is taken for the other: the Control Room's
// harness (src/code-agents/openhands.ts, the timmy-openhands:1.21.0 container) and the MCP tool timmy_openhands_run (the
// attempts runner, timmy-oh-runner:1.21.0-attempts-1, adopted from the OpenHands checkpoint b56c36f0). Neither image is
// built by Timmy; a missing one is a named blocker.
import { useEffect, useState } from 'react';
import { getJson } from '../api.js';
import { Page, Panel } from '../shell.jsx';
import { goTo, projectQuery } from '../store.js';
import { Empty, Facts, StateWord } from '../ui.jsx';
import { AgentRuns } from './control-runs.jsx';
import './control.css';

export default function OpenHandsPage() {
  const [h, setH] = useState(null);
  useEffect(() => { getJson(`/api/control/harnesses${projectQuery()}`).then(setH); }, []);
  const oh = h && h.ok ? (h.harnesses || []).find((x) => x.id === 'openhands') : null;
  const models = h && h.ok ? (h.models || []) : [];
  return (
    <Page id="openhands"
      band={[
        ['HARNESS', !h ? <span className="ta-muted">reading…</span> : !h.ok ? <span className="ta-muted">{h.error || 'not read'}</span> : oh ? <StateWord word={oh.found ? 'found here' : 'needs setup'} /> : <span className="ta-muted">not offered</span>],
        ['LOCAL MODELS', !h ? <span className="ta-muted">reading…</span> : models.length ? <>{models.length} <span className="ta-muted">· this computer’s Ollama</span></> : <span className="ta-muted">{(h && h.modelsError) || 'none listed'}</span>],
        ['SPEND', <span key="s">$0 <span className="ta-muted">· local models only; no paid run is authorized</span></span>],
      ]}
      context={
        <>
          <p className="ta-context-k">WHAT RUNS WHERE</p>
          <Facts rows={[
            ['this page', 'the Control Room’s OpenHands harness: timmy act on a disposable copy, container timmy-openhands:1.21.0'],
            ['MCP tool', 'timmy_openhands_run: the attempts runner timmy-oh-runner:1.21.0-attempts-1 (durable attempts, one bounded correction, checks green in the copy and in a pristine clone)'],
            ['built by Timmy', 'neither image: build it yourself; a missing image is named, never replaced'],
          ]} />
          <button type="button" className="ta-link" onClick={() => goTo('control')}>Every harness in the Control Room →</button>
        </>
      }>
      {oh && !oh.found ? (
        <Panel id="openhands-setup" kicker="BLOCKED HERE" title="OpenHands is not set up on this computer">
          <p className="ta-result" role="status">{oh.needs}.</p>
          <p className="ta-muted">Process connectivity, the work’s outcome and its independent check are three different facts: until the harness is found here, none of them is claimed.</p>
        </Panel>
      ) : null}
      {h && !h.ok ? <Panel id="openhands-setup" kicker="NOT READ" title="The harness list did not answer"><Empty>{h.error || 'The companion did not answer.'}</Empty></Panel> : null}
      <AgentRuns only="openhands" title="Run OpenHands on a copy of this project" />
    </Page>
  );
}
