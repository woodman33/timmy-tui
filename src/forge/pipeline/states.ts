// Pipeline state machine — PURE transition logic. No I/O, no Date, no random:
// determinism is the contract. The runner (runner.ts) layers ledger I/O on top.
// at_seq contract: the pure machine uses history.length; recordTransition
// RETURNS the ledger seq of the pipeline_stage record it wrote — it does not
// rewrite history. Callers building resumable snapshots must pair that seq
// with the next state themselves; v1 does not persist counters or snapshots
// (see the runner header limitations).

export type Stage =
  | 'intake'
  | 'pre_vetting'
  | 'probe'
  | 'probe_judging'
  | 'iterate'
  | 'escalate'
  | 'full_render'
  | 'chain'
  | 'done'
  | 'quarantined'
  | 'aborted';

export type EventName =
  | 'submitted'
  | 'passed'
  | 'failed'
  | 'hard_failed'
  | 'completed'
  | 'nsfw'
  | 'timeout'
  | 'revised'
  | 'budget_exhausted'
  | 'approved'
  | 'denied'
  | 'max_iterations'
  | 'escalated_passed'
  | 'escalated_failed';

export interface PipelineConfig {
  on_budget_exhausted: 'escalate' | 'abort';
  max_probe_attempts: number;
  max_iterations: number;
}

export interface HistoryEntry {
  stage: Stage;
  event: EventName;
  at_seq: number; // pure transition uses history.length; see file header for the ledger-seq contract
}

export interface PipelineState {
  mission_id: string;
  stage: Stage;
  prompt_version_id: string;
  probe_attempts: number; // probe failures since pre_vetting passed (not reset on revision — the cap bounds total failures, making rule 1 reachable)
  iterations: number; // total iterate passes
  degraded: boolean; // arrived at full_render via budget-exhausted escalation
  toxic: boolean; // nsfw observed — prompt version must never rerun
  config: PipelineConfig;
  history: HistoryEntry[];
}

export interface TransitionResult {
  state: PipelineState; // new object; input never mutated
  entered: Stage;
}

const TERMINAL: ReadonlySet<Stage> = new Set(['done', 'quarantined', 'aborted']);

interface Patch {
  stage: Stage;
  event: EventName; // effective event recorded in history (may be redirected, e.g. max_iterations)
  probe_attempts?: number;
  iterations?: number;
  degraded?: boolean;
  toxic?: boolean;
}

function apply(state: PipelineState, p: Patch): TransitionResult {
  const next: PipelineState = {
    ...state,
    stage: p.stage,
    probe_attempts: p.probe_attempts ?? state.probe_attempts,
    iterations: p.iterations ?? state.iterations,
    degraded: p.degraded ?? state.degraded,
    toxic: p.toxic ?? state.toxic,
    history: [...state.history, { stage: p.stage, event: p.event, at_seq: state.history.length }],
  };
  return { state: next, entered: p.stage };
}

// Iterate is a counter stage: any transition that would enter it first
// passes through here so the iteration cap can redirect to escalate.
function enterIterate(state: PipelineState, event: EventName): TransitionResult {
  const iterations = state.iterations + 1;
  if (iterations > state.config.max_iterations) {
    return apply(state, { stage: 'escalate', event: 'max_iterations' });
  }
  return apply(state, { stage: 'iterate', event, iterations });
}

export function transition(state: PipelineState, event: EventName): TransitionResult {
  if (!state.config || !['abort', 'escalate'].includes(state.config.on_budget_exhausted) ||
      ![state.probe_attempts, state.iterations, state.config.max_probe_attempts, state.config.max_iterations]
        .every(n => Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER)) {
    throw new Error('invalid pipeline counters or limits');
  }
  if (state.toxic && (event === 'submitted' || event === 'revised')) {
    throw new Error('toxic prompt version — refusing to rerun');
  }
  if (TERMINAL.has(state.stage)) {
    throw new Error('illegal event for terminal state');
  }

  // nsfw scope: nsfw → toxic+quarantined only at the generation states
  // (probe, full_render); an nsfw event anywhere else falls through to the
  // illegal-event throw below, per the table.
  switch (state.stage) {
    case 'intake':
      if (event === 'submitted') return apply(state, { stage: 'pre_vetting', event });
      break;

    case 'pre_vetting':
      if (event === 'passed') return apply(state, { stage: 'probe', event, probe_attempts: 0 });
      if (event === 'failed') return enterIterate(state, event);
      if (event === 'hard_failed') return apply(state, { stage: 'quarantined', event });
      break;

    case 'probe':
      if (event === 'completed') {
        return apply(state, { stage: 'probe_judging', event });
      }
      if (event === 'failed' || event === 'timeout') {
        const attempts = state.probe_attempts + 1;
        if (attempts > state.config.max_probe_attempts) {
          // retry rule: quarantine instead of another iterate pass
          return apply(state, { stage: 'quarantined', event, probe_attempts: attempts });
        }
        return enterIterate({ ...state, probe_attempts: attempts }, event);
      }
      if (event === 'nsfw') {
        return apply(state, { stage: 'quarantined', event, toxic: true });
      }
      break;

    case 'probe_judging':
      if (event === 'passed' || event === 'escalated_passed') {
        return apply(state, { stage: 'full_render', event });
      }
      if (event === 'failed' || event === 'escalated_failed') return enterIterate(state, event);
      break;

    case 'iterate':
      if (event === 'budget_exhausted') {
        if (state.config.on_budget_exhausted === 'abort') {
          return apply(state, { stage: 'aborted', event });
        }
        return apply(state, { stage: 'escalate', event, degraded: true });
      }
      if (event === 'revised') return apply(state, { stage: 'probe', event });
      if (event === 'max_iterations') return apply(state, { stage: 'escalate', event });
      break;

    case 'escalate':
      if (event === 'approved') return apply(state, { stage: 'full_render', event });
      if (event === 'denied') return apply(state, { stage: 'aborted', event });
      break;

    case 'full_render':
      if (event === 'completed') return apply(state, { stage: 'chain', event });
      if (event === 'failed' || event === 'timeout') return enterIterate(state, event);
      if (event === 'nsfw') return apply(state, { stage: 'quarantined', event, toxic: true });
      break;

    case 'chain':
      if (event === 'completed') return apply(state, { stage: 'done', event });
      if (event === 'failed') return apply(state, { stage: 'aborted', event });
      break;

    default:
      break;
  }

  throw new Error(`illegal: ${state.stage} + ${event}`);
}
