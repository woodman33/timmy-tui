// Canonical higgsfield-lane plan-hash seam (B1 fix): ONE plan-hash shape
// binds operator approval tokens across BOTH mint surfaces — the MCP-advertised
// forgeRun plan (`timmy_forge_run` → `timmy approve <planHash>`) and the
// gen.ts dispatch gate (`timmy gen --approval <token>`). Before this module the
// two seams hashed different shapes (forgeRun added tool/beats/stage/provider),
// so a token minted via the MCP-advertised flow failed consumeApproval in
// gen.ts with 'approval bound to a different plan hash'.
//
// Canonical spend-binding shape — EXACTLY these four fields:
//   { mission_id, prompt_hash, endpoint, max_spend }
// tool / beats / stage / provider live in the sealed forge.plan receipt, NOT
// in the spend-binding hash: the token binds WHAT is spent on (mission +
// prompt identity + endpoint + ceiling), not how the plan was advertised.
import { createHash } from 'node:crypto';
import { planHashOf } from '../utils/approvals.js';

// V2 separates prompt identity from all raw strings and records only the
// admitted beat schema. Legacy approval hashes deliberately do not match:
// the operator must approve the current plan again; there is no legacy fallback.
// Empty/absent beats are equivalent. Canonical key and timeline order ensures
// that equivalent JSON does not require a different approval.
export function promptHashOf(prompt: string, beats?: Array<{ id: string; t: number }>): string {
  if (typeof prompt !== 'string') throw new Error('prompt must be a string');
  if (beats !== undefined && !Array.isArray(beats)) throw new Error('beats must be an array');
  const ids = new Set<string>();
  const times = new Set<number>();
  const canonicalBeats = Array.from(beats ?? []).map((beat) => {
    if (!beat || typeof beat !== 'object' || Array.isArray(beat) ||
        Object.keys(beat).sort().join(',') !== 'id,t') throw new Error('each beat must contain only id and t');
    if (typeof beat.id !== 'string' || !beat.id.trim()) throw new Error('beat id must be a nonempty string');
    if (typeof beat.t !== 'number' || !Number.isFinite(beat.t) || beat.t < 0) throw new Error('beat time must be finite and nonnegative');
    if (ids.has(beat.id) || times.has(beat.t)) throw new Error('beat ids and times must be unique');
    ids.add(beat.id);
    times.add(beat.t);
    return { id: beat.id, t: beat.t };
  }).sort((a, b) => a.t - b.t);
  const payload = JSON.stringify({ schema: 'timmy-hf-prompt/v2', prompt, beats: canonicalBeats });
  return 'sha256_' + createHash('sha256').update(payload).digest('hex');
}

// The current outer four-field shape is shared by MCP and dispatch. It is
// not byte-compatible with the pre-B1 slot_id shape or legacy prompt hashes.
export function higgsfieldPlanHash(input: {
  mission_id: string;
  prompt_hash: string;
  endpoint: string;
  max_spend?: number;
}): string {
  if (input.max_spend !== undefined &&
      (typeof input.max_spend !== 'number' || !Number.isFinite(input.max_spend) || input.max_spend < 0)) {
    throw new Error('max_spend must be finite and nonnegative');
  }
  return planHashOf({
    mission_id: input.mission_id,
    prompt_hash: input.prompt_hash,
    endpoint: input.endpoint,
    max_spend: input.max_spend ?? 0,
  });
}
