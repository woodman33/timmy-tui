// Orchestrator modes (Task 10): approval vs autonomous spending, pure logic.
//
// APPROVAL mode: every paid call needs an operator token (the Task 5 gate);
// canSpend refuses all autonomous spending so the caller falls through to
// the token gate.
//
// AUTONOMOUS mode: paid calls proceed without per-call tokens, but only
// inside a DispatchPlan envelope (PlanCaps): a max_spend budget, probe/render
// call caps, and a live balance check before each paid call. Balance comes
// from resolveBalance — measured via the Higgsfield endpoint when reachable,
// else operator-declared (labeled declared per the evidence rules), else
// unavailable.
//
// Spend accounting rule (documented, honest): spent_usd accumulates the
// caller's validated estimate per paid call (est_cost_usd); this is not a
// measured provider charge. A fresh measured balance already reflects past
// charges, while a declared starting balance must subtract mission spend.
// Unavailable or malformed balances stop autonomous spending.
//
// A balance refusal signals hard_stop: true. The caller then runs hardStop()
// (mode → approval, hard_stopped: true — irreversible to autonomous without
// operator reapproval) and receipts the switch via recordModeSwitch
// (kind 'orchestrator_mode'). All functions here are pure; the ledger I/O
// lives in runner.ts.
//
// RECONCILIATION LIMITATION (documented, honest): max_spend_usd caps the
// caller's ESTIMATES, not provider charges. If real provider costs
// systematically exceed estimates, real spend can exceed the plan with no
// in-band signal — this is a documented limitation, not a silent guarantee.
// The real-spend check is reconciliation against provider invoices or
// balance re-probes (a fresh probe that shows spent more than the plan
// allows is the hard stop); per-call cost reconciliation is out of scope for
// v1.
//
// BALANCE STALENESS CONTRACT: canSpend takes the Balance as an argument, so
// the CALLER owns freshness — the contract is a resolveBalance re-probe
// before EACH paid call, not caching a Balance across calls. A 'declared'
// balance is a mission-start snapshot: a long autonomous run spending
// against it measures nothing, so running on a stale declared balance is
// the documented risk (prefer the re-probe). When probe and declared are
// both unavailable, autonomous spending stops; absence of evidence is not
// implicit operator acceptance of unknown credit exposure.
//
// RACE/ATOMICITY: canSpend → paid call → applySpend is check-then-act with
// no lock; between the check and the ledger increment another writer could
// interleave. v1 assumes a single writer (matching the ledger's one-writer
// discipline); concurrent writers must serialize at the ledger layer.
import type { Balance } from '../higgsfield/balance.js';

export type OrchestratorMode = 'approval' | 'autonomous';

export interface PlanCaps {
  max_spend_usd: number;
  max_probe_calls: number;
  max_render_calls: number;
  declared_balance_usd?: number;
}

export interface OrchestratorState {
  mission_id: string;
  mode: OrchestratorMode;
  // Sum of est_cost_usd over this mission's paid calls (see accounting rule
  // above). NOT a measured provider total.
  spent_usd: number;
  probe_calls: number;
  render_calls: number;
  // Balance stop fired. While true, autonomous spending is refused outright;
  // only operator reapproval (fresh state, hard_stopped false) restores it.
  hard_stopped: boolean;
}

export function makeOrchestratorState(missionId: string, over: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    mission_id: missionId,
    mode: 'approval',
    spent_usd: 0,
    probe_calls: 0,
    render_calls: 0,
    hard_stopped: false,
    ...over,
  };
}

export type SpendDecision =
  | { ok: true; balance_unavailable?: boolean }
  | { ok: false; reason: string; hard_stop?: boolean };

const nonnegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
const count = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
function validState(state: OrchestratorState): boolean {
  return Boolean(state) && typeof state.mission_id === 'string' && Boolean(state.mission_id.trim()) &&
    (state.mode === 'approval' || state.mode === 'autonomous') &&
    typeof state.hard_stopped === 'boolean' && nonnegative(state.spent_usd) &&
    count(state.probe_calls) && count(state.render_calls);
}

export function canSpend(
  state: OrchestratorState,
  caps: PlanCaps,
  balance: Balance,
  est_cost_usd: number,
  kind: 'probe' | 'render'
): SpendDecision {
  // FIRST check: a poisoned estimate must not reach the budget/balance
  // guards — NaN would disable both comparisons. Zero is a real estimate
  // (free probes) and passes.
  if (!Number.isFinite(est_cost_usd) || est_cost_usd < 0) {
    return { ok: false, reason: 'non-finite or negative estimate refused' };
  }
  if (!validState(state) || !caps || !nonnegative(caps.max_spend_usd) ||
      !count(caps.max_probe_calls) || !count(caps.max_render_calls) ||
      (kind !== 'probe' && kind !== 'render')) {
    return { ok: false, reason: 'invalid spend state, plan caps, or call kind', hard_stop: true };
  }
  if (state.hard_stopped) {
    return { ok: false, reason: 'hard stop active — operator must reapprove' };
  }
  if (state.mode === 'approval') {
    return { ok: false, reason: 'approval mode — operator token required' };
  }
  if (!Number.isFinite(state.spent_usd + est_cost_usd) || state.spent_usd + est_cost_usd > caps.max_spend_usd) {
    return { ok: false, reason: 'plan budget exhausted' };
  }
  if (kind === 'probe' && state.probe_calls >= caps.max_probe_calls) {
    return { ok: false, reason: `probe call cap reached (${caps.max_probe_calls})` };
  }
  if (kind === 'render' && state.render_calls >= caps.max_render_calls) {
    return { ok: false, reason: `render call cap reached (${caps.max_render_calls})` };
  }
  if (!balance || balance.usd === null || !nonnegative(balance.usd) ||
      (balance.source !== 'measured' && balance.source !== 'declared')) {
    return { ok: false, reason: 'balance unavailable or invalid — operator must reapprove', hard_stop: true };
  }
  const required = est_cost_usd + (balance.source === 'declared' ? state.spent_usd : 0);
  if (balance.usd < required) {
    return {
      ok: false,
      reason: `balance ${balance.usd} (${balance.source}) below required amount ${required}`,
      hard_stop: true,
    };
  }
  return { ok: true };
}

// Pure counter/spend increment; returns a NEW state (callers discard the old
// one on refusal — applySpend must only run after a canSpend pass).
//
// Hard stop at the act: applySpend throws on hard_stopped or non-autonomous
// mode — the guard lives here, not just in canSpend, so a caller that skips
// the check cannot corrupt the ledger.
//
// REVALUATION HONESTY: reapproval-after-stop is a ledger-auditable CONVENTION,
// not structural enforcement. OrchestratorState is a plain object — nothing
// prevents a caller from constructing a fresh state with hard_stopped false.
// The proof of operator reapproval is the ledger receipt (recordModeSwitch,
// kind 'orchestrator_mode'): an autonomous state that appears without a
// matching receipt is an audit finding, not a state the type system forbids.
export function applySpend(
  state: OrchestratorState,
  kind: 'probe' | 'render',
  est_cost_usd: number
): OrchestratorState {
  if (!validState(state) || (kind !== 'probe' && kind !== 'render')) {
    throw new Error('invalid spend state or call kind');
  }
  if (state.hard_stopped || state.mode !== 'autonomous') {
    throw new Error('spend applied outside autonomous mode / after hard stop — run canSpend first');
  }
  // Defense in depth (mirrors the canSpend first check): the pure act must
  // not corrupt state with a poisoned estimate, and a negative increment is
  // a refund exploit, not accounting.
  if (!Number.isFinite(est_cost_usd) || est_cost_usd < 0) {
    throw new Error('non-finite or negative estimate refused');
  }
  const next = {
    ...state,
    spent_usd: state.spent_usd + est_cost_usd,
    probe_calls: state.probe_calls + (kind === 'probe' ? 1 : 0),
    render_calls: state.render_calls + (kind === 'render' ? 1 : 0),
  };
  if (!validState(next)) throw new Error('spend accounting overflow');
  return next;
}

// The balance stop: revert to approval mode and latch the stop. Irreversible
// to autonomous without operator reapproval (a fresh state).
export function hardStop(state: OrchestratorState): OrchestratorState {
  return { ...state, mode: 'approval', hard_stopped: true };
}
