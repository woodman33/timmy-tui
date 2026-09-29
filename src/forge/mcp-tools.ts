// FORGE MCP tool surface (Task 15): timmy_forge_run / timmy_forge_status /
// timmy_forge_approve. Implementations live here — pure-ish, dir-injectable —
// so src/mcp/server.ts stays a thin dispatcher (one case line per tool).
// Every call seals exactly one receipt on the 'runs' stream through the
// canonical appendReceipt path (DESIGN §1 read-only law; denials seal too,
// mirroring llmCall in server.ts). TIMMY_FORGE=1 gates all three (D1).
// timmy_forge_approve is SURFACE-ONLY: it surfaces the operator CLI command
// and mints nothing — the mint path is `timmy approve <planHash>` (cli.ts).
// Chain bloat (accepted v1 property): each tool call seals exactly one
// receipt by design ('a refusal is an event'), so agent loops can grow the
// append-only chain without bound. Operators rate-limit at the client; the
// ledger lock serializes writers.
import { existsSync, readFileSync } from 'node:fs';
import { appendReceipt, readChain, receiptsPath, verifyChain, verifySignature } from '../utils/receipts.js';
import { higgsfieldPlanHash, promptHashOf } from './plan-hash.js';
import { readLedger, type LedgerRecord } from './ledger.js';
import { hfReadiness } from './higgsfield/config.js';
import { forgeEnabled } from './gen.js';
import type { OrchestratorMode } from './pipeline/orchestrator.js';

export type ForgeStage = 't2i' | 'i2v' | 'speak';
export type ForgeProvider = 'higgsfield-stub' | 'higgsfield';

export interface ForgeRunBrief {
  mission_id: string;
  prompt: string;
  beats?: Array<{ id: string; t: number }>;
  stage: ForgeStage;
  provider: ForgeProvider;
  max_spend_usd?: number;
  declared_balance_usd?: number;
}

export interface ForgeCaps {
  max_spend_usd: number;
  declared_balance_usd: number | null;
}

// The approved plan shape — the CANONICAL higgsfield-lane spend-binding shape
// (src/forge/plan-hash.ts): exactly { mission_id, prompt_hash, endpoint,
// max_spend }. prompt_hash folds in the beats (prompt identity); tool/beats/
// stage/provider live in the sealed forge.plan receipt, NOT in this hash, so a
// token minted here (`timmy approve <planHash>`) consumes cleanly at the
// gen.ts dispatch gate (hfSlotPlanHash builds the same four-field shape with
// mission_id === slot_id). Changing ANY hashed field invalidates the token.
export function forgeRunPlanOf(brief: ForgeRunBrief) {
  return {
    mission_id: brief.mission_id,
    prompt_hash: promptHashOf(brief.prompt, brief.beats),
    endpoint: 'dop-turbo', // shared live endpoint id (gen.ts HF_LIVE_ENDPOINT)
    max_spend: brief.max_spend_usd ?? 0,
  };
}

// forgeRunPlanOf returns exactly the canonical four-field shape, so hashing it
// with planHashOf equals higgsfieldPlanHash over the same inputs — this is the
// single assertion the cross-seam contract rests on.
export const forgeRunPlanHash = (brief: ForgeRunBrief): string =>
  higgsfieldPlanHash({
    mission_id: brief.mission_id,
    prompt_hash: promptHashOf(brief.prompt, brief.beats),
    endpoint: 'dop-turbo',
    max_spend: brief.max_spend_usd ?? 0,
  });

const GATE_NOTE = 'forge lane gated: run with TIMMY_FORGE=1 (D1)';

const STAGES: readonly string[] = ['t2i', 'i2v', 'speak'];
const PROVIDERS: readonly string[] = ['higgsfield-stub', 'higgsfield'];
const MISSION_ID_MAX = 128;
const PROMPT_MAX = 262144; // 256KB cap
const BEATS_MAX = 100;
const BEAT_ID_MAX = 64;

// Runtime brief validation (hostile-caller review): forgeRun validates BEFORE
// building anything. mission_id/prompt are only hashed/stringified (no extra
// escaping beyond JSON — the chain stays one-record-per-line). Any violation
// seals one forge.plan denial receipt and returns {ok:false, reason} — never
// throws, never builds a plan from garbage.
function validateBrief(brief: unknown): string | null {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return 'brief must be an object';
  const b = brief as Record<string, unknown>;
  if (typeof b.mission_id !== 'string' || b.mission_id.length < 1 || b.mission_id.length > MISSION_ID_MAX)
    return `mission_id must be a string of 1..${MISSION_ID_MAX} chars`;
  if (typeof b.prompt !== 'string' || b.prompt.length < 1 || b.prompt.length > PROMPT_MAX)
    return `prompt must be a string of 1..${PROMPT_MAX} chars`;
  if (typeof b.stage !== 'string' || !STAGES.includes(b.stage)) return `stage must be one of ${STAGES.join(', ')}`;
  if (typeof b.provider !== 'string' || !PROVIDERS.includes(b.provider)) return `provider must be one of ${PROVIDERS.join(', ')}`;
  if (b.beats !== undefined) {
    if (!Array.isArray(b.beats)) return 'beats must be an array';
    if (b.beats.length > BEATS_MAX) return `beats must have at most ${BEATS_MAX} items`;
    const ids = new Set<string>(), times = new Set<number>();
    for (const beat of b.beats) {
      if (!beat || typeof beat !== 'object' || Array.isArray(beat)) return 'each beat must be an object {id, t}';
      const beatObj = beat as Record<string, unknown>;
      if (Object.keys(beatObj).some(key => key !== 'id' && key !== 't')) return 'beat contains unsupported fields';
      if (typeof beatObj.id !== 'string' || beatObj.id.length < 1 || beatObj.id.length > BEAT_ID_MAX)
        return `each beat.id must be a string of 1..${BEAT_ID_MAX} chars`;
      if (typeof beatObj.t !== 'number' || !Number.isFinite(beatObj.t) || beatObj.t < 0)
        return 'each beat.t must be a finite number >= 0';
      if (ids.has(beatObj.id) || times.has(beatObj.t)) return 'beat IDs and times must be unique';
      ids.add(beatObj.id); times.add(beatObj.t);
    }
  }
  for (const key of ['max_spend_usd', 'declared_balance_usd'] as const) {
    const v = b[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))
      return `${key} must be a finite number >= 0`;
  }
  return null;
}

// A denied brief still seals one receipt (kind forge.plan, status denied) —
// a refusal is an event on the chain, not silence.
function briefDenial(reason: string, dir?: string) {
  const rec = appendReceipt('runs', {
    kind: 'forge.plan', subject: 'forge plan DENIED (invalid brief)',
    policy: 'auto', status: 'denied', error_class: 'invalid_brief', reason,
    spans: [], artifacts: [],
  } as never, dir);
  return { ok: false as const, reason, receipt: rec.hash };
}

// A gated call still seals one receipt (kind forge.gate, status denied) —
// a refusal is an event on the chain, not silence.
function gateRefusal(tool: string, dir?: string) {
  const rec = appendReceipt('runs', {
    kind: 'forge.gate', subject: `${tool} DENIED (forge gate)`,
    policy: 'auto', status: 'denied', error_class: 'gated',
    spans: [], artifacts: [],
  } as never, dir);
  return { ok: false as const, denied: true as const, error: GATE_NOTE, receipt: rec.hash };
}

// Planning is free: builds the DispatchPlan-shaped object, proposes the mode,
// reports readiness and spends nothing. Storage failures may still throw.
export function forgeRun(brief: ForgeRunBrief, dir?: string) {
  if (!forgeEnabled()) return gateRefusal('timmy_forge_run', dir);
  const invalid = validateBrief(brief);
  if (invalid) return briefDenial(invalid, dir);
  let plan: ReturnType<typeof forgeRunPlanOf>, planHash: string;
  try {
    plan = forgeRunPlanOf(brief);
    planHash = forgeRunPlanHash(brief);
  } catch {
    return briefDenial('invalid plan inputs', dir);
  }
  const caps: ForgeCaps = {
    max_spend_usd: brief.max_spend_usd ?? 0,
    declared_balance_usd: brief.declared_balance_usd ?? null,
  };
  const readiness = hfReadiness();
  const liveBlocked = brief.provider === 'higgsfield' && readiness.status !== 'ready';
  const rec = appendReceipt('runs', {
    kind: 'forge.plan',
    subject: `forge plan ${brief.mission_id} · ${brief.stage} · ${brief.provider}`,
    policy: 'auto',
    status: 'ok',
    plan_hash: planHash,
    prompt_hash: plan.prompt_hash,
    model_requested: brief.provider,
    via: brief.provider,
    max_spend: plan.max_spend,
    caps,
    spans: [], artifacts: [],
  } as never, dir);
  return {
    ok: true as const,
    planHash,
    plan,
    caps,
    mode: 'approval' as const, // operator pre-approval is the only path to autonomous
    readiness,
    next: `timmy_forge_approve ${planHash}`,
    receipt: rec.hash,
    // Live spend without credentials: the plan stands (planning is free),
    // but the operator must know spend is blocked until HF_CREDENTIALS lands.
    ...(liveBlocked ? { warning: `live spend blocked until credentials: ${readiness.detail}` } : {}),
  };
}

export interface ForgeStatusResult {
  ok: true;
  mission_id: string;
  stage: string;
  submissions_open: number;
  toxic: boolean;
  mode: OrchestratorMode | string;
  receipt: string;
}

// Mirror runner admission identities: exact open sequence for new closes,
// complete mission/version/segment tuple for legacy closes. A stale close
// never clears a newer opening. Keep this projection aligned with runner.ts.
function countOpenSubmissions(rows: LedgerRecord[], missionId: string): number {
  const opens = new Map<number, { tuple: string; missionId: string }>();
  for (const r of rows.filter(row => row.kind === 'pipeline_submission')) {
    const ids = [r.mission_id, r.prompt_version_id, r.segment];
    if (ids.some(id => typeof id !== 'string' || !id.trim())) throw new Error('invalid submission identity');
    const tuple = JSON.stringify(ids);
    if (r.action === 'open') opens.set(r.seq, { tuple, missionId: r.mission_id as string });
    else if (r.action === 'close') {
      if (Object.hasOwn(r, 'open_seq')) {
        if (typeof r.open_seq !== 'number' || !Number.isSafeInteger(r.open_seq) || r.open_seq < 0 || r.open_seq >= r.seq) {
          throw new Error('invalid close sequence');
        }
        const opening = opens.get(r.open_seq);
        if (opening !== undefined && opening.tuple !== tuple) throw new Error('close identity mismatch');
        opens.delete(r.open_seq);
      } else {
        const matches = [...opens].filter(([, value]) => value.tuple === tuple);
        if (matches.length > 1) throw new Error('ambiguous legacy close');
        if (matches[0]) opens.delete(matches[0][0]);
      }
    } else throw new Error('invalid submission action');
  }
  return [...opens.values()].filter(open => open.missionId === missionId).length;
}

// Status is a verified projection, not an execution permission. Prompt-version
// toxicity is global, as in runner admission, but only versions associated with
// this mission contribute to its flag (including submission-only history).
export function forgeStatus(mission_id: unknown, dir?: string): ForgeStatusResult | { ok: false; denied: true; error: string; receipt: string } | { ok: false; reason: string; receipt: string } {
  if (!forgeEnabled()) return gateRefusal('timmy_forge_status', dir);
  if (typeof mission_id !== 'string' || mission_id.length < 1 || mission_id.length > MISSION_ID_MAX) {
    const reason = `mission_id must be a string of 1..${MISSION_ID_MAX} chars`;
    const rec = appendReceipt('runs', {
      kind: 'forge.status', subject: 'forge status DENIED (invalid mission_id)',
      policy: 'auto', status: 'denied', error_class: 'invalid_mission_id',
      spans: [], artifacts: [],
    } as never, dir);
    return { ok: false as const, reason, receipt: rec.hash };
  }
  let open: number, toxic: boolean, stage: string, mode: string;
  try {
    const rows = readLedger(dir, { verify: true });
    const mine = rows.filter(r => r.mission_id === mission_id);
    const stages = mine.filter(r => r.kind === 'pipeline_stage');
    const latestStage = stages[stages.length - 1];
    open = countOpenSubmissions(rows, mission_id);
    const pvIds = new Set(mine.map(r => r.prompt_version_id).filter((id): id is string => typeof id === 'string'));
    toxic = rows.some(r => typeof r.prompt_version_id === 'string' && pvIds.has(r.prompt_version_id) &&
      (r.kind === 'pipeline_toxic' || (r.kind === 'pipeline_stage' && r.event === 'nsfw')));
    const modes = mine.filter(r => r.kind === 'orchestrator_mode');
    const latestMode = modes[modes.length - 1];
    if (latestStage && typeof latestStage.to !== 'string') throw new Error('invalid pipeline stage');
    if (latestMode && typeof latestMode.to !== 'string') throw new Error('invalid pipeline mode');
    stage = latestStage ? String(latestStage.to) : 'intake';
    mode = latestMode ? String(latestMode.to) : 'approval';
    if (!['intake', 'pre_vetting', 'probe', 'probe_judging', 'iterate', 'escalate', 'full_render', 'chain', 'done', 'quarantined', 'aborted'].includes(stage) ||
        !['approval', 'autonomous'].includes(mode)) throw new Error('invalid pipeline status');
  } catch {
    const reason = 'forge ledger could not be verified';
    const rec = appendReceipt('runs', { kind: 'forge.status', subject: 'forge status FAILED',
      policy: 'auto', status: 'failed', error_class: 'invalid_ledger', spans: [], artifacts: [] }, dir);
    return { ok: false as const, reason, receipt: rec.hash };
  }
  const rec = appendReceipt('runs', {
    kind: 'forge.status', subject: `forge status ${mission_id}`,
    policy: 'auto', status: 'ok', plan_hash: undefined,
    spans: [], artifacts: [],
  } as never, dir);
  return {
    ok: true,
    mission_id,
    stage,
    submissions_open: open,
    toxic,
    mode,
    receipt: rec.hash,
  };
}

const PLAN_HASH_RE = /^[0-9a-f]{32}$/; // planHashOf digest shape

// SURFACE-ONLY operator gate (hostile-caller review, adjudicated): MCP-exposed
// minting collapses the operator gate, so this tool MINTS NOTHING. It validates
// the planHash, checks the chain for a sealed forge.plan with that plan_hash,
// and surfaces the exact CLI command the operator must run. The mint path is
// CLI-only: `timmy approve <planHash>` (src/cli.ts), which binds max_spend at
// plan time — approve-time ceilings were a false control (Critical #3), so the
// old opts.max_spend_usd arg is gone. A malformed planHash or an unsealed plan
// is an error result, never a crash — and still seals one receipt.
export function forgeApprove(planHash: unknown, dir?: string) {
  if (!forgeEnabled()) return gateRefusal('timmy_forge_approve', dir);
  if (typeof planHash !== 'string' || !PLAN_HASH_RE.test(planHash)) {
    const rec = appendReceipt('runs', {
      kind: 'forge.approve', subject: 'forge approve DENIED (malformed planHash)',
      policy: 'human-gated', status: 'denied', error_class: 'malformed_plan_hash',
      spans: [], artifacts: [],
    } as never, dir);
    return { ok: false as const, error: 'malformed planHash: expected the 32-char hex planHash from timmy_forge_run', receipt: rec.hash };
  }
  let planSealed = false;
  try {
    const path = receiptsPath('runs', dir);
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (text && !text.endsWith('\n')) throw new Error('incomplete receipt stream');
    // readChain intentionally tolerates damaged historical lines; approval
    // surfacing must not silently use that lossy interpretation.
    const physicalRows = text ? text.slice(0, -1).split('\n').map(line => JSON.parse(line)) : [];
    if (physicalRows.some(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
      if (Object.hasOwn(row, 'hash')) return typeof row.hash !== 'string';
      // runs.jsonl is also the bus: its unsigned envelopes are intentionally
      // outside the signed subset, but malformed/non-envelope rows refuse.
      return row.v !== 1 || typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)) ||
        typeof row.kind !== 'string' || !row.kind || !row.payload || typeof row.payload !== 'object' ||
        Array.isArray(row.payload) || Object.keys(row).some(key => !['v', 'ts', 'kind', 'payload'].includes(key));
    })) throw new Error('invalid receipt stream');
    const chain = readChain('runs', dir);
    const verified = verifyChain('runs', dir);
    if (physicalRows.filter(row => Object.hasOwn(row, 'hash')).length !== chain.length || !verified.ok || verified.segments.some(segment => !segment.ok)) {
      throw new Error('unverified receipt stream');
    }
    planSealed = chain.some(r => r.kind === 'forge.plan' && r.status === 'ok' &&
      r.plan_hash === planHash && verifySignature(r));
  } catch {
    const rec = appendReceipt('runs', { kind: 'forge.approve', subject: 'forge approve DENIED (unverified history)',
      policy: 'human-gated', status: 'denied', error_class: 'unverified_plan_chain',
      spans: [], artifacts: [] }, dir);
    return { ok: false as const, error: 'forge plan history could not be verified', receipt: rec.hash };
  }
  if (!planSealed) {
    const rec = appendReceipt('runs', {
      kind: 'forge.approve', subject: `forge approve ${planHash}`,
      policy: 'human-gated', status: 'denied', error_class: 'no_sealed_plan',
      plan_hash: planHash,
      spans: [], artifacts: [],
    } as never, dir);
    return { ok: false as const, error: 'no sealed forge.plan for this hash', receipt: rec.hash };
  }
  // Sealed plan found: surface the operator command, mint nothing. The receipt
  // records that the gate was exercised (status 'surfaced', not a mint).
  const rec = appendReceipt('runs', {
    kind: 'forge.approve', subject: planHash,
    policy: 'human-gated', status: 'surfaced',
    plan_hash: planHash,
    spans: [], artifacts: [],
  }, dir);
  return {
    ok: true as const,
    approved: false as const,
    needs: 'operator' as const,
    cli: `timmy approve ${planHash}`,
    plan_sealed: true as const,
    note: 'approval must be minted by the operator via the CLI — agents cannot self-approve',
    receipt: rec.hash,
  };
}
