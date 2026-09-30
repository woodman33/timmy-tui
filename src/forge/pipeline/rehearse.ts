// Rehearsal runner (Task 20): replay a RECORDED mission through the REAL
// pipeline machinery — states.ts transition(), runner.ts ledger I/O
// (submitMission/recordTransition/recordRunStarted/recordModeSwitch),
// orchestrator.ts spend gates (canSpend/applySpend/hardStop) — at $0, with
// generation served by dryrun.ts replay (dryGenerate only; NO network, NO
// hfGenerate, NO credentials). This resolves the dryrun.ts scoping decision:
// replay keys are mission-namespaced (scopedRequestKeyOf) and the replay
// index is mission-scoped (buildReplayIndex(dir, mission_id)).
//
// $0 BY CONSTRUCTION: the only generate path here is dryGenerate over an
// in-memory Map built from the ledger. There is no client import, no
// fetcher, no async boundary where a network call could hide.
//
// FAIL CLOSED: a stage whose request has no recorded response THROWS
// ('rehearsal: no recorded response for <scoped key>') — a rehearsal that
// silently skipped a paid stage would prove nothing.
//
// SCRIPT MODEL: stages carry the request each generation attempt replays;
// outcomes is a flat per-ATTEMPT queue (one entry per generation call, so a
// probe iterate-retry consumes TWO outcomes: 'failed' then 'completed').
// Probe judging is scripted-pass — a 'completed' probe drives
// probe_judging → passed → full_render (rehearsal does not model judges;
// judges are covered by the golden suite). Config not carried by the script
// uses fixed rehearsal defaults: on_budget_exhausted 'escalate',
// max_probe_attempts 2, max_iterations 3. Iterate reuses the same
// prompt_version (no rewriter in rehearsal) and the same stage request.
//
// GATE SEMANTICS: every generation attempt passes the real canSpend gate
// against the caps and the declared balance (hard-stopping when undeclared),
// and the gate runs BEFORE submitMission: a refused spend
// leaves NO submission evidence — nothing ran, so the ledger must show
// nothing. A refusal ends the rehearsal — the mission could not proceed —
// with hard-stop semantics per orchestrator.ts: a refusal carrying
// hard_stop: true latches hardStop() and receipts the mode switch. A final
// simulateSpendCurve assertion over the replayed calls vs max_spend_usd is
// the last gate before the aggregate result returns.
//
// HONEST FINISHES: the rehearsal drives only probe/full_render stages and
// the iterate→revised retry. When the machine lands anywhere else after a
// transition — TERMINAL (finish), iterate (retry), or an unhandled
// legitimate state like escalate (iteration cap) — the runner finishes
// honestly with that stage and a note; it never throws on a legitimate
// machine state. The same applies to script exhaustion (outcomes shorter
// than stages: checked BEFORE any spend/run evidence is recorded).
import {
  buildReplayIndex,
  dryGenerate,
  estimateRecordedCostFloor,
  scopedRequestKeyOf,
  simulateSpendCurve,
} from './dryrun.js';
import { transition, type EventName, type PipelineState } from './states.js';
import {
  recordModeSwitch,
  recordRunStarted,
  recordTransition,
  submitMission,
} from './runner.js';
import {
  applySpend,
  canSpend,
  hardStop,
  makeOrchestratorState,
  type OrchestratorState,
  type PlanCaps,
} from './orchestrator.js';
import type { Balance } from '../higgsfield/balance.js';
import type { HfGenResult } from '../higgsfield/client.js';

export interface RehearsalStage {
  stage: 'probe' | 'full_render';
  request: { endpoint: string; input: Record<string, unknown> };
  kind: 'probe' | 'render';
}

export type RehearsalOutcome = 'completed' | 'failed' | 'nsfw' | 'timeout';

export interface RehearsalScript {
  mission_id: string;
  caps: { max_spend_usd: number; max_probe_calls: number; max_render_calls: number };
  // 'declared' evidence per the orchestrator rules: a mission-start snapshot,
  // labeled declared — never measured. Absent balance hard-stops the run.
  declared_balance_usd?: number;
  stages: RehearsalStage[];
  // One outcome per generation ATTEMPT (probe iterate-retry consumes one
  // outcome per probe call). Exhaustion ends the rehearsal.
  outcomes: RehearsalOutcome[];
}

export interface RehearsalResult {
  final_stage: string;
  spent_usd: number;
  probe_calls: number;
  render_calls: number;
  curve: { ok: boolean };
  ledger_seqs: number[];
  hard_stopped: boolean;
  // Set when the rehearsal finished without reaching a terminal stage for a
  // reason other than a spend refusal: 'iteration cap reached — escalated
  // to operator', 'script outcomes exhausted', or an unexpected-stage note.
  note?: string;
}

const TERMINAL: ReadonlySet<string> = new Set(['done', 'quarantined', 'aborted']);

export async function rehearse(dir: string, script: RehearsalScript): Promise<RehearsalResult> {
  const id = script.mission_id;
  const caps: PlanCaps = { ...script.caps };
  // Reject malformed scripts before writing any approval or run evidence.
  scopedRequestKeyOf(id, 'rehearsal', {});
  if (!simulateSpendCurve([], caps, estimateRecordedCostFloor).ok ||
      !Number.isSafeInteger(caps.max_probe_calls) || caps.max_probe_calls < 0 ||
      !Number.isSafeInteger(caps.max_render_calls) || caps.max_render_calls < 0)
    throw new Error('rehearsal: invalid plan caps');
  if (!Array.isArray(script.stages) || !Array.isArray(script.outcomes) ||
      script.outcomes.some(o => !['completed', 'failed', 'nsfw', 'timeout'].includes(o)))
    throw new Error('rehearsal: invalid script outcomes');
  for (const stage of script.stages) {
    if (!stage || (stage.stage !== 'probe' && stage.stage !== 'full_render') ||
        stage.kind !== (stage.stage === 'probe' ? 'probe' : 'render'))
      throw new Error('rehearsal: stage and call kind mismatch');
    scopedRequestKeyOf(id, stage.request.endpoint, stage.request.input);
  }
  // Declared per the evidence rules — labeled, never measured.
  const balance: Balance = script.declared_balance_usd !== undefined
    ? { usd: script.declared_balance_usd, source: 'declared', detail: 'rehearsal: operator-declared balance (declared, not measured)' }
    : { usd: null, source: 'unavailable', detail: 'rehearsal: no balance source — autonomous spending refused' };

  // Orchestrator: approval → autonomous on operator plan approval; the
  // receipt lands once for the whole rehearsal (a hard stop appends a second).
  let orch: OrchestratorState = makeOrchestratorState(id);
  const ledger_seqs: number[] = [];
  ledger_seqs.push(
    recordModeSwitch(dir, { mission_id: id, from: 'approval', to: 'autonomous', reason: 'rehearsal: operator plan approval' }).seq
  );
  orch = { ...orch, mode: 'autonomous' };

  // Mission-scoped replay index: only THIS mission's records (Task-20
  // namespacing — no cross-mission contamination).
  const index = buildReplayIndex(dir, id);

  let state: PipelineState = {
    mission_id: id,
    stage: 'intake',
    prompt_version_id: `${id}/pv1`, // fixed: rehearsal has no rewriter
    probe_attempts: 0,
    iterations: 0,
    degraded: false,
    toxic: false,
    config: { on_budget_exhausted: 'escalate', max_probe_attempts: 2, max_iterations: 3 },
    history: [],
  };

  // Returns the stage the machine landed on. The return value (rather than
  // reading state.stage) is what callers branch on: TS narrows state.stage
  // at the call site and does not see this closure's reassignment.
  const step = (event: EventName): string => {
    const r = transition(state, event); // pure machine
    ledger_seqs.push(recordTransition(dir, state, r.state, event)); // ledger I/O + close logic
    state = r.state;
    return r.state.stage;
  };

  const replayed: HfGenResult[] = [];
  let hard_stopped = false;
  let note: string | undefined;
  let stageIdx = 0;
  let outcomeIdx = 0;

  step('submitted'); // intake → pre_vetting
  step('passed');    // pre_vetting → probe (scripted vetting pass)

  for (;;) {
    if (TERMINAL.has(state.stage)) break;
    if (state.stage !== 'probe' && state.stage !== 'full_render') {
      // escalate/iterate without a driver: script and machine diverged —
      // finish honestly; never throw on a legitimate machine state.
      note ??= `unexpected stage '${state.stage}': script and machine diverged`;
      break;
    }
    const stage = script.stages[stageIdx];
    if (!stage || stage.stage !== state.stage) break; // stages consumed / script drift: stop honestly
    const kind = stage.kind;

    // Replay first: dryGenerate is $0 and idempotent, and the recorded
    // response supplies the honest floor estimate the gates below decide on.
    // A missing recording is a fail-closed throw BEFORE any ledger evidence
    // of an attempt — the rehearsal cannot proceed.
    const hit = dryGenerate(index, stage.request, id);
    if (!hit.replayed) {
      throw new Error(
        `rehearsal: no recorded response for ${scopedRequestKeyOf(id, stage.request.endpoint, stage.request.input)}`
      );
    }
    const result = hit.result;
    if (result.probe !== (stage.stage === 'probe'))
      throw new Error('rehearsal: recorded result and stage kind mismatch');
    const est = estimateRecordedCostFloor(result);

    // Outcome availability BEFORE any spend or run evidence: an exhausted
    // script must leave no run_started (and no submission) for a phantom
    // attempt at the unconsumed stage.
    const outcome = script.outcomes[outcomeIdx];
    if (outcome === undefined) {
      note = 'script outcomes exhausted'; // stage stays as-is; nothing spent
      break;
    }
    outcomeIdx++;

    // Gate BEFORE submission: a refused spend must leave NO submission
    // evidence — nothing ran, so the ledger must show nothing.
    const dec = canSpend(orch, caps, balance, est, kind);
    if (!dec.ok) {
      // The mission could not pay for this stage. hard_stop refusals latch
      // the stop and receipt the mode switch per orchestrator rules; other
      // refusals (plan/call caps) end the rehearsal at the current stage.
      if (dec.hard_stop) {
        orch = hardStop(orch);
        ledger_seqs.push(
          recordModeSwitch(dir, { mission_id: id, from: 'autonomous', to: 'approval', reason: `rehearsal: ${dec.reason}` }).seq
        );
        hard_stopped = true;
      }
      break;
    }

    // Real in-flight submission guard (dedup is the close semantics' partner;
    // probe→probe_judging→full_render keeps one open across the paid path).
    // Only reached once the spend gate passed — a refusal never opens one.
    const sub = submitMission(dir, { mission_id: id, prompt_version_id: state.prompt_version_id, segment: 'main' });
    if (!sub.ok && sub.reason !== 'duplicate submission in flight') {
      throw new Error(`rehearsal: submitMission refused: ${sub.reason}`);
    }

    orch = applySpend(orch, kind, est);
    ledger_seqs.push(
      recordRunStarted(dir, {
        mission_id: id,
        prompt_version_id: state.prompt_version_id,
        segment: 'main',
        stage: state.stage,
        endpoint: stage.request.endpoint,
        plan_seq: ledger_seqs[0]!,
      })
    );
    replayed.push(result);

    if (state.stage === 'probe') {
      if (outcome === 'nsfw') {
        step('nsfw'); // → quarantined, toxic; remaining stages NOT consumed
        break;
      }
      if (outcome === 'failed' || outcome === 'timeout') {
        const landed = step(outcome); // → iterate — or quarantined (probe cap) / escalate (iteration cap)
        if (landed === 'iterate') {
          step('revised'); // iterate → probe; retry per the state machine rules
          continue;        // same stage entry supplies the re-probe request
        }
        if (!TERMINAL.has(landed)) {
          // A legitimate machine state the rehearsal driver does not handle
          // (iteration cap → escalate). Finish honestly; never throw.
          note = landed === 'escalate'
            ? 'iteration cap reached — escalated to operator'
            : `unexpected stage '${landed}' after ${outcome}`;
        }
        break;
      }
      step('completed'); // → probe_judging
      step('passed');    // judging scripted-pass → full_render
      stageIdx++;
      continue;
    }

    // full_render
    if (outcome === 'nsfw') {
      step('nsfw'); // → quarantined, toxic
      break;
    }
    if (outcome === 'failed' || outcome === 'timeout') {
      const landed = step(outcome); // → iterate — or escalate (iteration cap)
      if (landed === 'iterate') {
        step('revised'); // iterate → probe: the loop re-drives from the machine
        stageIdx++;      // render stage consumed; a later probe stage (if any) supplies the retry
        continue;
      }
      if (!TERMINAL.has(landed)) {
        // A legitimate machine state the rehearsal driver does not handle
        // (iteration cap → escalate). Finish honestly; never throw.
        note = landed === 'escalate'
          ? 'iteration cap reached — escalated to operator'
          : `unexpected stage '${landed}' after ${outcome}`;
      }
      break;
    }
    step('completed'); // → chain
    step('completed'); // → done
    stageIdx++;
    break;
  }

  // Final gate: the replayed spend curve must hold within the mission cap.
  const curve = simulateSpendCurve(replayed, { max_spend_usd: caps.max_spend_usd }, estimateRecordedCostFloor);
  if (!curve.ok) {
    throw new Error(`rehearsal: spend curve exceeded cap: ${JSON.stringify(curve)}`);
  }

  return {
    final_stage: state.stage,
    spent_usd: orch.spent_usd,
    probe_calls: orch.probe_calls,
    render_calls: orch.render_calls,
    curve: { ok: curve.ok },
    ledger_seqs,
    hard_stopped,
    note,
  };
}
