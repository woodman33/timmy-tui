// FORGE gen lane (p13; decisions.md D1-D5; DESIGN.md §1 read-only law —
// we append receipts through the canonical API, never edit chain logic).
// `timmy gen`: seals gen.request BEFORE dispatch and gen.result AFTER, with
// meta {provider, model, prompt_hash, slot_id, cost, latency_ms,
// artifact_hash, local}. local is COMPUTED (D2): true only when the dispatch
// path consulted no API key.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendReceipt } from '../utils/receipts.js';
import { consumeApproval } from '../utils/approvals.js';
import { higgsfieldPlanHash, promptHashOf } from './plan-hash.js';
import { hfGenerate, type HfGenResult } from './higgsfield/client.js';
import { loadSheet, validateSheet, type ForgeSheet, type ForgeSlot } from './sheet.js';

export const forgeEnabled = (): boolean => process.env.TIMMY_FORGE === '1';

export const sha256 = (b: Buffer | string): string =>
  'sha256_' + createHash('sha256').update(b).digest('hex');

export interface GenOpts {
  sheet?: string;
  slots?: string[];
  provider?: string;
  stub?: boolean;
  allowSpend?: boolean;
  approval?: string;
  maxSpend?: number;
  dir?: string;
}
export interface GenLine { slot_id: string; request: string; result: string; artifact: string; local: boolean; cost: number; cost_measured?: boolean; ms: number }

// D2: local is a fact about the path taken, never a claim.
const pathUsesNoKey = (provider: string): boolean =>
  provider === 'stub' || provider === 'higgsfield-stub' ||
  (provider === 'comfy' && !process.env.COMFY_CLOUD_API_KEY && !process.env.COMFY_CLOUD_TOKEN);

// Shared live endpoint id: the plan hash binds the token to THIS endpoint, so
// the constant is single-sourced between hashing and dispatch — a drift here
// would silently invalidate every minted token.
const HF_LIVE_ENDPOINT = 'dop-turbo';

// Operator-token plan hash for a higgsfield slot (mirrors openhands-adapter):
// the CANONICAL four-field higgsfield-lane shape built via the shared builder
// (src/forge/plan-hash.ts) — mission_id (= slot_id) + prompt hash + endpoint +
// spend bound. MCP and dispatch share V2 prompt identity; older approvals
// deliberately no longer match and must be issued again by the operator.
// Thin wrapper retained for existing imports.
export const hfSlotPlanHash = (slot: ForgeSlot, max_spend: number | undefined): string =>
  higgsfieldPlanHash({ mission_id: slot.slot_id, prompt_hash: promptHashOf(slot.prompt), endpoint: HF_LIVE_ENDPOINT, max_spend });

interface DispatchResult { artifact: string; bytes: Buffer; cost: number; model: string; cost_measured?: boolean; request_id?: string }

// A resolved provider call is not necessarily a successful generation. Keep
// terminal outcomes typed so receipt admission cannot turn a refusal or an
// absent artifact into success. Do not include remote URLs in error messages.
class HfOutcomeError extends Error {
  readonly spend_status = 'unknown' as const;
  constructor(
    readonly request_id: string,
    readonly provider_status: HfGenResult['status'],
    readonly artifact_status: 'missing' | 'invalid' | 'present',
  ) {
    super(`higgsfield outcome rejected: provider_status=${provider_status} artifact_status=${artifact_status}`);
    this.name = 'HfOutcomeError';
  }
}

function admitHfOutcome(result: HfGenResult): void {
  let artifactStatus: HfOutcomeError['artifact_status'] = 'missing';
  if (typeof result.artifact_url === 'string' && result.artifact_url.length > 0) {
    artifactStatus = 'invalid';
    try {
      const url = new URL(result.artifact_url);
      if (['https:', 'http:'].includes(url.protocol) && url.hostname &&
          !url.username && !url.password && !/\s/.test(result.artifact_url)) artifactStatus = 'present';
    } catch { /* Preserve invalid as its own observed outcome. */ }
  }
  if (result.status !== 'completed' || artifactStatus !== 'present') {
    throw new HfOutcomeError(result.request_id, result.status, artifactStatus);
  }
}

// Spend-marker extraction from a thrown higgsfield client error: the client's
// enriched reconcileError carries `request_id=<id> spend=unknown|unlikely` in
// its message (accepted server-side → unknown; rejected pre-acceptance →
// unlikely). No request_id at all means nothing reached the provider
// (rejected_pre_spend). Structured properties are checked first; the message
// regex is the defensive fallback for plain-Error carriers.
const hfFailureDetail = (err: unknown): { request_id?: string; spend_status: 'unknown' | 'unlikely' | 'rejected_pre_spend' } => {
  const e = err as { request_id?: unknown; response?: { request_id?: unknown }; body?: { request_id?: unknown }; message?: unknown } | null | undefined;
  const structured = e?.request_id ?? e?.response?.request_id ?? e?.body?.request_id;
  const msg = typeof e?.message === 'string' ? e.message : String(err ?? '');
  const m = msg.match(/request_id=([^\s]+)/);
  const request_id = (typeof structured === 'string' && structured.length > 0) ? structured : (m ? m[1] : undefined);
  const spend_status = err instanceof HfOutcomeError ? err.spend_status : /spend=unknown/.test(msg) ? 'unknown' : /spend=unlikely/.test(msg) ? 'unlikely' : 'rejected_pre_spend';
  return { ...(request_id ? { request_id } : {}), spend_status };
};

async function dispatch(slot: ForgeSlot, provider: string, promptHash: string, allowSpend: boolean, dir: string, approval?: string, maxSpend?: number): Promise<DispatchResult> {
  const outDir = join(dir, '.timmy', 'forge');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${slot.slot_id}.bin`);
  if (provider === 'stub') {
    const bytes = Buffer.from(`TIMMY-FORGE-STUB ${slot.slot_id} ${promptHash} ${slot.prompt}`);
    writeFileSync(out, bytes);
    return { artifact: out, bytes, cost: 0, model: 'stub/deterministic' };
  }
  if (provider === 'comfy') {
    // thin adapter over comfyui-cli; partner spend is consent-gated like the
    // comfy CLI itself (spend_consent_required).
    if (!allowSpend) throw new Error('spend consent required: rerun with --allow-spend');
    const r = spawnSync('comfy', ['generate', slot.provider_pref || 'flux-ultra', '--prompt', slot.prompt, '--download', out], { encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0 || !existsSync(out)) throw new Error(`comfyui-cli dispatch failed: ${(r.stderr ?? r.stdout ?? '').slice(0, 200)}`);
    const bytes = readFileSync(out);
    return { artifact: out, bytes, cost: 0.05, model: `comfy/${slot.provider_pref || 'flux-ultra'}` };
  }
  if (provider === 'comfy-mcp') {
    // wired through the existing cmcp WIRE slot (D5); honest when absent.
    throw new Error('comfy-mcp not configured in the cmcp wire — not_configured (D5)');
  }
  if (provider === 'higgsfield-stub') {
    // $0 deterministic stub: no credentials, no approval — spend authority is
    // not implicated at zero cost. Receipt cost is a genuinely measured $0.
    const r = await hfGenerate({ endpoint: 'dop-turbo', input: { prompt: slot.prompt }, mode: 'stub' });
    const bytes = Buffer.from(r.artifact_url);
    writeFileSync(out, bytes);
    return { artifact: out, bytes, cost: 0, model: 'higgsfield/dop-turbo', cost_measured: true, request_id: r.request_id };
  }
  if (provider === 'higgsfield') {
    // Operator-token spend gate (NOT --allow-spend): single-use token bound to
    // this exact plan hash, plus a hard max_spend bound — the openhands-adapter
    // pattern. Approval is checked BEFORE any spend; hfGenerate itself still
    // denies without HF_CREDENTIALS (defense in depth). Token burn-on-failure
    // is intended: the token is single-use and consumed at the gate, so a
    // failed generation still invalidates the approval (no replay).
    const planHash = hfSlotPlanHash(slot, maxSpend);
    const gate = consumeApproval(approval ?? '', planHash);
    if (!gate.ok) throw new Error(`approval required: timmy approve ${planHash} (${gate.note})`);
    if (!(Number(maxSpend) > 0)) throw new Error('spend_policy: max_spend bound required for higgsfield live');
    const r = await hfGenerate({ endpoint: HF_LIVE_ENDPOINT, input: { prompt: slot.prompt }, mode: 'live' });
    admitHfOutcome(r); // BEFORE creating an artifact or admitting a success receipt.
    // artifact_url is sealed as the artifact record; fetching remote bytes is
    // a later stage's job (assembly/timeline).
    const bytes = Buffer.from(r.artifact_url);
    writeFileSync(out, bytes);
    // cost_measured:false → declared-unknown: record $0, never a measured $0
    // (Task 4 amendment). cost is honored verbatim when measurement lands.
    // Aggregators honor cost_measured since Task 21 (measuredCostUsd in
    // src/utils/receipts.ts): this $0 placeholder is excluded from measured
    // sums and counted as declared-unknown instead.
    return { artifact: out, bytes, cost: r.cost_measured ? r.cost_usd : 0, model: 'higgsfield/dop-turbo', cost_measured: r.cost_measured, request_id: r.request_id };
  }
  throw new Error(`unknown forge provider ${provider}`);
}

export async function runGen(opts: GenOpts): Promise<GenLine[]> {
  if (!forgeEnabled()) throw new Error('forge lane gated: run with TIMMY_FORGE=1 (D1)');
  let sheet: ForgeSheet;
  if (opts.sheet) {
    sheet = loadSheet(opts.sheet);
  } else {
    throw new Error('timmy gen needs --sheet <tldraw.json> (reference-sheet contract)');
  }
  validateSheet(sheet); // CUE gate BEFORE any gen fires (D3)
  const dir = opts.dir ?? process.cwd();
  const chosen = sheet.slots.filter(s => s.required || !opts.slots || opts.slots.length === 0 || opts.slots.includes(s.slot_id));
  const lines: GenLine[] = [];
  for (const slot of chosen) {
    if (opts.slots && opts.slots.length > 0 && !opts.slots.includes(slot.slot_id)) continue; // agent fills fewer optionals
    const provider = opts.provider ?? (opts.stub ? 'stub' : slot.provider_pref);
    const promptHash = promptHashOf(slot.prompt);
    const req = appendReceipt('runs', {
      kind: 'gen.request', subject: `forge ${slot.slot_id} · ${slot.prompt.slice(0, 40)}`,
      policy: 'auto', prompt_hash: promptHash, model_requested: slot.provider_pref,
      via: provider, sources: [{ slot_id: slot.slot_id, class: slot.class, required: slot.required, est_cost_usd: slot.est_cost_usd ?? 0 }],
    } as never, dir);
    const t0 = Date.now();
    let d: DispatchResult;
    try {
      d = await dispatch(slot, provider, promptHash, Boolean(opts.allowSpend), dir, opts.approval, opts.maxSpend);
    } catch (err) {
      // Failure-path receipt (review-sanctioned): any throw out of the
      // higgsfield live branch seals a failed/denied gen.result BEFORE
      // the error propagates. The worst case — a request accepted server-side
      // whose outcome (and spend) we never learned — must still leave a
      // receipt on the chain carrying request_id + spend_status. Receipts do
      // not replace error propagation: the rethrow below is unconditional.
      if (provider === 'higgsfield') {
        const det = hfFailureDetail(err);
        const msg = err instanceof Error ? err.message : String(err);
        appendReceipt('runs', {
          kind: 'gen.result', subject: `forge ${slot.slot_id} · ${slot.prompt.slice(0, 40)}`,
          policy: 'auto', prompt_hash: promptHash, model_resolved: 'higgsfield/dop-turbo', via: provider,
          ms: Date.now() - t0, cost_usd: 0, artifacts: [],
          status: err instanceof HfOutcomeError && err.provider_status === 'nsfw' ? 'denied' : 'failed',
          error_class: err instanceof HfOutcomeError ? 'provider_outcome' : /approval/.test(msg) ? 'approval' : 'exec', error: msg,
          ...(err instanceof HfOutcomeError ? { provider_status: err.provider_status, artifact_status: err.artifact_status } : {}),
          // cost_measured:false → declared-unknown (aggregators count it via
          // declaredUnknownCostUsd, never sum it — Task 21).
          cost_measured: false, spend_status: det.spend_status,
          ...(det.request_id ? { request_id: det.request_id } : {}),
          sources: [{ slot_id: slot.slot_id, local: false }],
        } as never, dir);
      }
      throw err;
    }
    const ms = Date.now() - t0;
    const local = pathUsesNoKey(provider);
    const res = appendReceipt('runs', {
      kind: 'gen.result', subject: `forge ${slot.slot_id} · ${slot.prompt.slice(0, 40)}`,
      policy: 'auto', prompt_hash: promptHash, model_resolved: d.model, via: provider,
      ms, cost_usd: d.cost, output_sha256: sha256(d.bytes), artifacts: [d.artifact],
      status: 'ok', sources: [{ slot_id: slot.slot_id, local }],
      ...(d.cost_measured !== undefined ? { cost_measured: d.cost_measured } : {}),
      ...(d.request_id ? { request_id: d.request_id } : {}),
    } as never, dir);
    lines.push({ slot_id: slot.slot_id, request: req.hash, result: res.hash, artifact: d.artifact, local, cost: d.cost, ...(d.cost_measured !== undefined ? { cost_measured: d.cost_measured } : {}), ms });
  }
  return lines;
}
