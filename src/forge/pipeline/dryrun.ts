// Dry-run replay mode (Task 16): run the full forge pipeline — state machine,
// spend-gate math, budget caps — against RECORDED responses at $0.
//
// dryGenerate reads an in-memory Map built from the ledger. Its implementation
// imports no provider client, invokes no fetcher, and has no live fallback.
// An unknown request is refused. Synchronous execution and a TypeScript
// signature alone do not establish that arbitrary code cannot use a network.
//
// Replay source: kind 'generation' ledger records carrying request_key +
// response. v1 writes those via recordGeneration below — no prior src writer
// existed for this shape (src/utils/generations.ts recordGeneration targets a
// different store, .timmy/generations.json, and carries no request_key/
// response fields). Wiring hfGenerate's results into recordGeneration is a
// later task; gen.ts is intentionally untouched here. Records without a
// request_key (legacy/test shapes) are skipped on index build; a duplicate
// request_key resolves to the LATEST record (last write wins).
//
// Request key contract: '<endpoint>:<sha256(prompt)[:12]>' where the prompt
// is the canonical JSON of the request input — keys sorted recursively at
// every depth, arrays order-significant (the same canonicalization contract
// as ledger.ts hashOf, so keys are stable across object insertion order).
// Both sides of a record/replay pair MUST derive keys via requestKeyOf, or
// via scopedRequestKeyOf for the Task-20 mission-namespaced flavor
// ('<mission_id>:<endpoint>:<sha256[:12]>').
//
// SPEND ESTIMATE IS A FLOOR: estimateRecordedCostFloor counts a recorded
// call's cost_usd only when cost_measured is true; unknown-cost recordings
// (cost_measured falsy — declared-unknown per client.ts) estimate 0.
// simulateSpendCurve therefore under-estimates any mission containing
// unknown-cost calls; the assertion 'running total never exceeds the cap'
// holds against that floor, not against true provider spend.
import { createHash } from 'node:crypto';
import { appendLedger, readLedger } from '../ledger.js';
import type { HfGenResult } from '../higgsfield/client.js';

export interface RecordedResponse {
  request_key: string;   // stable key: '<endpoint>:<sha256(prompt)[:12]>' (see requestKeyOf)
  response: HfGenResult; // the recorded hfGenerate result (from a prior real or stub run)
}

// Canonical JSON: keys sorted recursively, arrays order-significant —
// mirrors the canon contract in ledger.ts so keys are insertion-order stable.
function canonValue(v: unknown, seen = new Set<object>()): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object') {
    if (seen.has(v)) throw new Error('replay request input must be acyclic JSON');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
      throw new Error('replay request input must be plain JSON');
    if (Object.getOwnPropertySymbols(v).length) throw new Error('replay request input must be plain JSON');
    seen.add(v);
    if (Array.isArray(v)) {
      const result = Array.from({ length: v.length }, (_, i) => canonValue(v[i], seen));
      seen.delete(v);
      return result;
    }
    const o = v as Record<string, unknown>;
    // Preserve the legacy omission of undefined object properties: JSON request
    // serialization omits those properties too, so the wire inputs are identical.
    const result = Object.fromEntries(Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => [k, canonValue(o[k], seen)]));
    seen.delete(v);
    return result;
  }
  throw new Error('replay request input must contain only finite JSON values');
}

function keyComponent(value: string): void {
  // Preserve existing unambiguous keys; refuse ambiguous historical identities,
  // rather than silently re-keying recordings or guessing their mission.
  if (typeof value !== 'string' || !value.trim() || value.includes(':'))
    throw new Error('replay key components must be nonempty and contain no colon');
}

// Shared key core: the canonical-JSON sha256[:12] digest of the request
// input. Both key flavors below derive from this one digest so a record and
// its replay lookup can never disagree on canonicalization.
function requestDigestOf(input: Record<string, unknown>): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('replay request input must be an object');
  return createHash('sha256')
    .update(JSON.stringify(canonValue(input)))
    .digest('hex')
    .slice(0, 12);
}

// Stable request key shared by the recording side (recordGeneration callers)
// and the replay side (dryGenerate). Distinct per endpoint AND per input.
//
// SCOPE — mission-global collisions are avoided for new records: new code uses scopedRequestKeyOf (mission-namespaced), and
// buildReplayIndex(dir, mission_id) isolates a mission's replay view. This
// legacy unscoped flavor remains for Task-16 records and the intentional
// whole-store cache use-case (a mission-agnostic cache may WANT the same
// endpoint+prompt to hit across missions); the whole-store index is
// last-write-wins, so an unscoped collision still resolves to the latest
// record — documented, not accidental.
export function requestKeyOf(endpoint: string, input: Record<string, unknown>): string {
  keyComponent(endpoint);
  return `${endpoint}:${requestDigestOf(input)}`;
}

// Mission-namespaced request key: '<mission_id>:<endpoint>:<sha256[:12]>'.
// Two missions issuing the same endpoint+prompt now produce DISTINCT keys,
// so their replay records cannot collide. The rehearsal runner (rehearse.ts)
// records and replays exclusively under this flavor; the mission_id is part
// of the hashed identity only by prefix, never inside the digest input, so
// the digest stays comparable to legacy keys for the same request.
export function scopedRequestKeyOf(mission_id: string, endpoint: string, input: Record<string, unknown>): string {
  keyComponent(mission_id);
  keyComponent(endpoint);
  return `${mission_id}:${endpoint}:${requestDigestOf(input)}`;
}

function isHfGenResult(v: unknown): v is HfGenResult {
  const r = v as HfGenResult | null | undefined;
  return Boolean(
    r && typeof r === 'object' &&
    typeof r.request_id === 'string' &&
    (r.status === 'completed' || r.status === 'failed' || r.status === 'nsfw') &&
    typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd) && r.cost_usd >= 0 &&
    (r.cost_measured === undefined || typeof r.cost_measured === 'boolean') &&
    typeof r.artifact_url === 'string' &&
    typeof r.probe === 'boolean'
  );
}

// Build the replay index from a store's forge ledger: every kind
// 'generation' record carrying a request_key and a response-shaped payload.
// Empty index when no such records exist — dryGenerate then refuses
// everything (fail closed).
//
// mission_id (Task 20): when given, index ONLY that mission's records —
// those whose mission_id field matches, or whose request_key carries the
// '<mission_id>:' prefix (scopedRequestKeyOf). Mission-tagged records with a
// legacy unscoped key still match via the field. Absent → the legacy
// whole-store behavior (the cache use-case), unchanged: last write wins
// across ALL missions.
export function buildReplayIndex(dir: string, mission_id?: string): Map<string, HfGenResult> {
  if (mission_id !== undefined) keyComponent(mission_id);
  const index = new Map<string, HfGenResult>();
  for (const r of readLedger(dir)) {
    if (r.kind !== 'generation') continue;
    if (typeof r.request_key !== 'string' || !isHfGenResult(r.response)) continue;
    if (mission_id !== undefined) {
      const tagged = r.mission_id === mission_id;
      const prefixed = r.request_key.startsWith(`${mission_id}:`);
      if (prefixed && r.mission_id !== undefined && !tagged)
        throw new Error('replay record mission tag conflicts with its scoped key');
      if (!tagged && !prefixed) continue;
      if (prefixed && r.request_key.split(':').length !== 3)
        throw new Error('ambiguous scoped replay key refused');
    }
    index.set(r.request_key, r.response); // duplicate key: latest record wins
  }
  return index;
}

// Recording side: write a kind 'generation' ledger record carrying the
// request key and the full hfGenerate result, so a later dry run can replay
// it. All ledger I/O goes through appendLedger (single-writer lock, hash
// chain). NOTE: nothing in src wrote this shape before Task 16 — the wiring
// that calls this from the pipeline is a later task (gen.ts untouched).
//
// mission_id (Task 20): when present, the record is stamped with the field
// AND the caller must pass the SCOPED key (scopedRequestKeyOf) as
// request_key — the record's request_key IS the scoped key. Absent → legacy
// Task-16 behavior: no mission_id field, unscoped key, still readable by
// both the whole-store index and any mission-scoped index via the
// '<mission_id>:' prefix rule (only when the key was scoped at write time).
export type RecordedMode = 'stub' | 'live' | 'replay';

export function recordGeneration(
  dir: string,
  rec: { request_key: string; response: HfGenResult; mode: RecordedMode; mission_id?: string }
): void {
  if (typeof rec.request_key !== 'string' || !rec.request_key.trim() || !isHfGenResult(rec.response) ||
      !['stub', 'live', 'replay'].includes(rec.mode)) throw new Error('invalid generation recording');
  if (rec.mission_id !== undefined) {
    keyComponent(rec.mission_id);
    if (!rec.request_key.startsWith(`${rec.mission_id}:`) || rec.request_key.split(':').length !== 3)
      throw new Error('generation recording requires an unambiguous key for its mission');
  }
  appendLedger(
    {
      kind: 'generation',
      request_key: rec.request_key,
      response: rec.response,
      mode: rec.mode,
      ...(rec.mission_id !== undefined ? { mission_id: rec.mission_id } : {}),
    },
    dir
  );
}

export type DryGenerateResult =
  | { replayed: true; result: HfGenResult }
  | { replayed: false; reason: string };

// THE dry-run generate. Synchronous, index-only, NEVER networks: an unknown
// request fails closed with an explicit refusal rather than spending.
//
// mission_id (Task 20): when given, the lookup key is the mission-scoped
// key (scopedRequestKeyOf) — pair with buildReplayIndex(dir, mission_id).
// Absent → the legacy unscoped key, for Task-16 records and the
// whole-store cache.
export function dryGenerate(
  index: Map<string, HfGenResult>,
  req: { endpoint: string; input: Record<string, unknown> },
  mission_id?: string
): DryGenerateResult {
  const key = mission_id !== undefined
    ? scopedRequestKeyOf(mission_id, req.endpoint, req.input)
    : requestKeyOf(req.endpoint, req.input);
  const hit = index.get(key);
  if (!hit) {
    return { replayed: false, reason: 'no recorded response — dry run refuses to spend' };
  }
  // Replay: a structuredClone of the index entry — never the index's
  // internal reference, so caller-side mutation of the returned result
  // cannot poison replays of the same key.
  return { replayed: true, result: structuredClone(hit) };
}

export interface SimulatedSpend {
  calls: number;
  estimated_spend_usd: number;
  cap_usd: number;
}

// The default estimateOf for simulateSpendCurve: measured costs count,
// unknown-cost recordings estimate 0 — the simulation is a FLOOR (see file
// header). cost_measured undefined is treated as unknown, never as measured.
export function estimateRecordedCostFloor(r: HfGenResult): number {
  return r.cost_measured === true ? r.cost_usd : 0;
}

// Run a simulated mission spend curve against a cap — pure. Walks the replay
// array in mission order, accumulating estimateOf; the moment the running
// total exceeds the cap it returns ok:false with the 0-based call index and
// the amounts. Boundary contract: running > cap is the only refusal, so
// exactly-at-cap passes. Empty replay is ok with zero calls.
// FAIL-CLOSED ESTIMATES: a step whose estimate is not finite (NaN, ±Infinity)
// or is negative refuses at that call — a cap assertion that passed on NaN
// would be the exact failure mode this module exists to prevent.
export function simulateSpendCurve(
  replay: HfGenResult[],
  caps: { max_spend_usd: number },
  estimateOf: (r: HfGenResult) => number
): { ok: true; spend: SimulatedSpend } | { ok: false; exceeded_at_call: number; running_usd: number; cap_usd: number } {
  let running = 0;
  if (!Number.isFinite(caps.max_spend_usd) || caps.max_spend_usd < 0)
    return { ok: false, exceeded_at_call: -1, running_usd: 0, cap_usd: caps.max_spend_usd };
  for (let i = 0; i < replay.length; i++) {
    const step = estimateOf(replay[i]);
    if (!Number.isFinite(step) || step < 0) {
      return { ok: false, exceeded_at_call: i, running_usd: running, cap_usd: caps.max_spend_usd };
    }
    running += step;
    if (!Number.isFinite(running) || running > caps.max_spend_usd) {
      return { ok: false, exceeded_at_call: i, running_usd: running, cap_usd: caps.max_spend_usd };
    }
  }
  return { ok: true, spend: { calls: replay.length, estimated_spend_usd: running, cap_usd: caps.max_spend_usd } };
}
