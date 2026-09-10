#!/usr/bin/env node
// timmy mcp serve — the Agent Trust OS as an MCP server.
// Any MCP-speaking agent (Qwen, Cursor, lanes, future ALE workers) can drive
// TIMMY through these tools; every call lands in the receipt chain.
// Raw stdio JSON-RPC, no SDK dep. Line-delimited messages.
import { captureEnvLock } from '../utils/envlock.js';
import { readEvents } from '../utils/eventbus.js';
import { publish as appendEvent } from '../bus/index.js';
import { verifyChain, appendReceipt } from '../utils/receipts.js';
import { replayFromEdl, } from '../utils/cliprunner.js';
import { listGenerations, recordGeneration, updateGeneration, extractArtifactFromLog } from '../utils/generations.js';
import { locateGenAgent, buildGenAgentArgs, launchDetached } from '../utils/genbridge.js';
import { GENERATION_PROVIDERS } from '../utils/providers.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { planHashOf, consumeApproval } from '../utils/approvals.js';
import { listLanes, createPlan, armPlan, dispatchPlan, tailLane, pauseOrCancelLane, collectRun, type DispatchPlan } from '../utils/dispatch.js';
import { compileMissionMap, type MissionMapDoc } from '../utils/slate-compiler.js';
import { runOpenHandsTask, openHandsPlanHash, type OpenHandsOpts } from '../utils/openhands-adapter.js';
import { roboflowRun, type RoboflowReq } from '../utils/roboflow-adapter.js';
import { oapiRun, type OapiReq } from '../utils/oapi-adapter.js';
import { VISION_TOOLS, callVisionTool } from '../vision/mcp.js';

const sleepSync = (ms: number) => spawnSync('sleep', [String(ms / 1000)]);

const TOOLS = [
  ...VISION_TOOLS,
  { name: 'timmy_env_lock', description: 'Environment lock: OS build, arch, tool BUILD HASHES (sha256 of binaries, not version strings).', inputSchema: { type: 'object', properties: {} } },
  { name: 'timmy_events_tail', description: 'Last N events from the timmy event bus (NDJSON spine).', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } },
  { name: 'timmy_receipt_verify', description: 'Walk the hash chain of a receipt stream; returns ok/brokenAt.', inputSchema: { type: 'object', properties: { stream: { type: 'string' } }, required: ['stream'] } },
  { name: 'timmy_clip_replay', description: 'Replay a sealed clip job from its EDL cut-list alone; verifies output sha match.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] } },
  { name: 'timmy_gen_run', description: 'Queue + execute a generation through the gen bridge (OpenRouter/local providers); sealed receipt on completion.', inputSchema: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' }, prompt: { type: 'string' }, kind: { type: 'string' } }, required: ['prompt'] } },
  { name: 'timmy_promo_apply', description: 'Apply a fused beats delta to the promo comp: replaces claim/sub/evidence text per beat id. from = source comp (default timmy-promo-v8); output is the next version (v9 → v10 etc).', inputSchema: { type: 'object', properties: { beats: { type: 'array' }, from: { type: 'string', description: 'source comp dir, default timmy-promo-v8' } }, required: ['beats'] } },
  { name: 'timmy_llm_call', description: 'Direct chat-completions call through TIMMY: openrouter direct (or the Cloudflare edge proxy when TIMMY_AI_PROXY is set), or the local ollama daemon (bare tags on-device, :cloud tags on ollama cloud; gated by TIMMY_ALLOW_LOCAL_OLLAMA=1). Every call sealed as a receipt with model + usage. Pre-tool hook validates the model (openrouter → ollama) before any call goes out. Bodybuilder-style fan-out = parallel calls; Fusion = one call with the outputs attached.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, prompt: { type: 'string' }, system: { type: 'string' }, requires_approval: { type: 'boolean', description: 'HITL gate: requires an operator approval token bound to this call' }, approval: { type: 'string', description: 'operator token from `timmy approve <planHash>` (single-use, 5min). A bare boolean never approves.' } }, required: ['model', 'prompt'] } },
  { name: 'timmy_fusion_plan', description: 'Resolve the owner-picked judge chain (local nemotron-3.5-lightning + qwen3.8:27b-mlx first, then gemini-3.7-flash floor, grok-4.6 frontier, ollama :cloud tags) against openrouter/ollama and return the available-judges list. Approval is operator-only via `timmy approve <planHash>`.', inputSchema: { type: 'object', properties: {} } },
  { name: 'timmy_promo_judge', description: 'Local-first promo judge loop: two free local judges score the current comp copy, a local fusion synthesizes edits + confidence; a frontier model arbitrates ONLY when confidence < threshold. Seals a receipt ($0 when local agrees). Returns proposed beat edits for human review before timmy_promo_apply.', inputSchema: { type: 'object', properties: { comp: { type: 'string', description: 'studio comp dir, default = latest timmy-promo-vN' }, threshold: { type: 'number', description: 'confidence below which frontier escalation fires (default 0.7)' } } } },
  { name: 'timmy_allyson_run', description: 'Allyson lane: animate a source SVG into an animated component via allyson-mcp (mcporter stdio). Every use logged to .timmy/runs/mcp-allyson-*.log + sealed receipt. Needs ALLYSON_API_KEY (allyson.ai) for generation; without it returns an honest needs_key.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, svg_path: { type: 'string', description: 'absolute source svg/png path' }, output_path: { type: 'string', description: 'absolute output component path' } }, required: ['prompt', 'svg_path', 'output_path'] } },
  { name: 'timmy_apify_run', description: 'Apify lane: call any mcp.apify.com tool (scrapers/actors) via mcporter http with bearer from env. Logged to .timmy/runs/mcp-apify-*.log + sealed receipt. Needs a valid APIFY_API_TOKEN from console.apify.com.', inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'apify MCP tool name, e.g. get-actor-list / call-actor' }, args: { type: 'object' } }, required: ['tool'] } },
  { name: 'timmy_3minapi_run', description: 'Optional helper lane: 3minapi no-code API builder (create/test/deploy data-capture endpoints, collaborator keys, webhooks, help topics). mcporter http with x-api-key from THREEMINAPI_KEY. Logged to .timmy/runs/mcp-3minapi-*.log + sealed receipt. Never on the critical path.', inputSchema: { type: 'object', properties: { tool: { type: 'string', description: '3minapi MCP tool, e.g. help / endpoints create / api_call / logs / deploy' }, args: { type: 'object' } }, required: ['tool'] } },
  { name: 'timmy_openhands_run', description: 'Command Post first slide: OpenHands headless in a disposable workspace (ephemeral repo copy, docker-backed runtime, scoped limits, deterministic acceptance tests). Real sandbox or nothing — fails closed not_configured. Paid work default-deny: operator token bound to the complete task hash. Returns patch + acceptance record + artifact hashes + child/parent receipts.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, fixture_repo: { type: 'string' }, ref: { type: 'string' }, wall_ms: { type: 'number' }, max_iterations: { type: 'number' }, approval: { type: 'string' } }, required: ['task', 'acceptance'] } },
  { name: 'timmy_oapi_run', description: 'OpenAPI lane: any OpenAPI spec becomes invocable tools via @mcpc/oapi-invoker-mcp (stdio, SPEC_URL env). list=true lists the spec tools; otherwise calls one. Sensitive fields masked by invoker extensions + timmy redact. Receipted.', inputSchema: { type: 'object', properties: { spec_url: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' }, list: { type: 'boolean' } }, required: ['spec_url'] } },
  { name: 'timmy_roboflow_run', description: 'Roboflow lane (SDK in project venv .timmy/venv-roboflow): upload images, run detection, or sample video frames as observer evidence (sample = ffmpeg frames -> upload). Key-gated: honest not_configured without ROBOFLOW_API_KEY. Every use receipted.', inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'upload | detect | sample' }, project: { type: 'string' }, path: { type: 'string' }, video: { type: 'string' }, frames: { type: 'number' }, every: { type: 'number' }, version: { type: 'number' }, confidence: { type: 'number' }, workspace: { type: 'string' } }, required: ['action', 'project'] } },
  { name: 'timmy_list_lanes', description: 'Command Post: list harness lanes (OpenHands/OpenCode/Pi/jcode/minds/…) with availability + install hints.', inputSchema: { type: 'object', properties: {} } },
  { name: 'timmy_plan_dispatch', description: 'Command Post: validate a full DispatchPlan (CUE) and store it ready/needs_approval. Returns plan id + immutable plan hash. Chat prepares; authority launches.', inputSchema: { type: 'object', properties: { plan: { type: 'object' } }, required: ['plan'] } },
  { name: 'timmy_mission_compile', description: 'Mission Map bridge: compile a tldraw mission doc (capsule/harness-slide/gate/artifact/result nodes + depends/harness/gate/artifact edges) into typed, CUE-validated DispatchPlans — dependency-ordered, sha256-pinned context manifests, gate-driven approval. The map never launches: feed the plans to timmy_plan_dispatch, then authority arms/launches.', inputSchema: { type: 'object', properties: { doc: { type: 'object', description: 'MissionMapDoc {nodes, edges}' }, repo_root: { type: 'string', description: 'repo root for artifact manifest hashing (default: server cwd)' } }, required: ['doc'] } },
  { name: 'timmy_dispatch_plan', description: 'Command Post: arm (operator token bound to the complete plan hash) and launch a stored plan into its harness lane. Real sandbox or nothing — refuses live-checkout workspaces, post-approval mutation, and unarmed plans. Every outcome receipted.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, approval: { type: 'string', description: 'operator token from `timmy approve <planHash>`' } }, required: ['id'] } },
  { name: 'timmy_tail_lane', description: 'Command Post: tail the last 40 pane lines of a dispatched plan session.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'timmy_pause_or_cancel_lane', description: 'Command Post: hold (SIGTSTP) or cancel (kill session) a dispatched plan; cancellations seal receipts.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string', description: 'hold | cancel' } }, required: ['id', 'action'] } },
  { name: 'timmy_collect_run', description: 'Command Post: collect a dispatched run (tail, wall-limit check, collect receipt, lifecycle → judging).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'timmy_judge_loop', description: 'One-command judge loop. Phase 1 (no approval): returns the resolved executor/judge plan + plan hash. Phase 2: requires an operator-minted single-use expiring token bound to that exact plan hash (`timmy approve <planHash>`); a bare boolean never approves. Runs 3-5 executors via Promise.allSettled, one configurable judge, child receipts per executor/judge + one parent receipt linking them. Default-deny on unresolved models or missing approval.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, system: { type: 'string' }, executors: { type: 'array', items: { type: 'string' } }, judge: { type: 'string' }, approval: { type: 'string', description: 'operator approval token from `timmy approve <planHash>`' }, max_spend: { type: 'number', description: 'approved USD ceiling (AgentPass max_spend); 0 = local/free routes only, paid routes denied' }, tier: { type: 'string', description: 'AgentPass clearance tier (default T0)' } }, required: ['prompt'] } }
];

// Judge chain (owner-picked order): free local first (M5-max optimized),
// cheap openrouter floor + one frontier, then ollama :cloud tags (the daemon routes them).
export const JUDGE_CHAIN = [
  'nemotron-3.5-lightning', 'qwen3.8:27b-mlx',
  'google/gemini-3.7-flash', 'x-ai/grok-4.6',
  'minimax-m3:cloud', 'kimi-k3:cloud', 'glm-5.2:cloud'
];

let orModelsCache: { at: number; ids: string[] } | null = null;
async function openrouterModels(): Promise<string[]> {
  if (orModelsCache && Date.now() - orModelsCache.at < 600000) return orModelsCache.ids;
  const proxy = process.env.TIMMY_AI_PROXY;
  try {
    const res = proxy
      ? await fetch(`${proxy}/models`)
      : await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${readApiKey()}` } });
    const j = (await res.json()) as any;
    const ids = Array.isArray(j) ? j.map((m: any) => m.id as string) : (j?.data ?? []).map((m: any) => m.id as string);
    orModelsCache = { at: Date.now(), ids };
    return ids;
  } catch { return orModelsCache?.ids ?? []; }
}

const localOllamaAllowed = (): boolean => process.env.TIMMY_ALLOW_LOCAL_OLLAMA === '1';
async function ollamaLocalModels(): Promise<string[]> {
  if (!localOllamaAllowed()) return [];
  try {
    const r = await fetch('http://localhost:11434/api/tags');
    const j = (await r.json()) as any;
    return (j?.models ?? []).map((m: any) => m.name as string);
  } catch { return []; }
}

// Pre-tool hook: every model id is validated before a call goes out.
// openrouter → ollama daemon (bare tags run on-device, :cloud tags on ollama
// cloud — the daemon routes; whole path gated by TIMMY_ALLOW_LOCAL_OLLAMA=1).
export async function resolveModel(id: string): Promise<{ via: string; id: string; suggestions?: string[] }> {
  const or = await openrouterModels();
  if (or.includes(id)) return { via: 'openrouter', id };
  const loc = await ollamaLocalModels();
  const tag = loc.find(m => m === id || m === `${id}:latest` || m.startsWith(id + ':'));
  if (tag) return { via: 'ollama', id: tag };
  const tail = id.split('/').pop() ?? id;
  return { via: 'none', id, suggestions: or.filter(m => m.includes(tail)).slice(0, 4) };
}

// No loose secrets in tool output, ever.
const redact = (s: string): string => s
  .replace(/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-REDACTED')
  .replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer REDACTED')
  .replace(/eyJ[A-Za-z0-9_-]{20,}/g, 'JWT-REDACTED');

const readApiKey = (): string => {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const env = readFileSync(join(process.cwd(), '.env'), 'utf8');
    const m = env.match(/^OPENROUTER_API_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
};

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const errClass = (status?: number, e?: unknown): string =>
  status ? (status < 500 ? 'http_4xx' : 'http_5xx') : e ? 'network' : 'unknown';

// Receipts v2: bind prompt hash + response hash (never raw content), requested
// vs resolved model, transport, latency, tokens, reported cost, status and
// error class. Failed and denied attempts seal too. Returns the receipt hash.
async function llmCall(args: { model: string; prompt: string; system?: string; requires_approval?: boolean; approval?: string }) {
  const messages = [
    ...(args.system ? [{ role: 'system', content: args.system }] : []),
    { role: 'user', content: args.prompt }
  ];
  const prompt_hash = sha256(JSON.stringify(messages));
  const base = { model_requested: args.model, prompt_hash };
  if (args.requires_approval) {
    // A bare boolean never approves: an operator-minted, single-use, expiring
    // token bound to this exact call's plan hash is required.
    const planHash = planHashOf({ tool: 'timmy_llm_call', model: args.model, prompt: args.prompt });
    const gate = consumeApproval(args.approval ?? '', planHash);
    if (!gate.ok) {
      appendEvent('run.gated', { model: args.model, note: gate.note });
      const rec = appendReceipt('runs', { kind: 'run', subject: `llm ${args.model} DENIED`, policy: 'human-gated', status: 'denied', error_class: 'approval', ...base, spans: [], artifacts: [] });
      return { ok: false, denied: true, needs_approval: true, planHash, note: `${gate.note} — operator: timmy approve ${planHash}, then re-invoke with approval:<token>`, receipt: rec.hash };
    }
  }
  const resolved = await resolveModel(args.model);
  if (resolved.via === 'none') {
    appendEvent('run.failed', { model: args.model, note: 'model not resolvable on any permitted provider' });
    const rec = appendReceipt('runs', { kind: 'run', subject: `llm ${args.model} UNRESOLVED`, policy: 'auto', status: 'denied', error_class: 'unresolved_model', ...base, spans: [], artifacts: [] });
    return { ok: false, needs_resolution: true, model: args.model, suggestions: resolved.suggestions, note: 'model not found on openrouter/ollama; pick a suggestion or permit ollama local (TIMMY_ALLOW_LOCAL_OLLAMA=1)', receipt: rec.hash };
  }
  const t0 = Date.now();
  if (resolved.via === 'ollama') {
    try {
      const r = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: resolved.id, messages, stream: false })
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        const raw = await r.text();
        appendEvent('run.failed', { model: resolved.id, status: r.status, ms });
        const rec = appendReceipt('runs', { kind: 'run', subject: `llm ${resolved.id}`, policy: 'auto', status: 'failed', error_class: errClass(r.status), ...base, model_resolved: resolved.id, via: 'ollama', ms, spans: [{ name: `chat ${resolved.id} via ollama`, kind: 'chat' }], artifacts: [] });
        return { ok: false, status: r.status, note: redact(raw.slice(0, 300)), ms, receipt: rec.hash };
      }
      const j = await r.json() as any;
      const text = redact(j?.message?.content ?? '');
      const tokens = (j?.eval_count ?? 0) + (j?.prompt_eval_count ?? 0);
      const rec = appendReceipt('runs', {
        kind: 'run',
        subject: `llm ${resolved.id}`,
        policy: args.requires_approval ? 'human-gated' : 'auto',
        status: 'ok',
        ...base,
        response_hash: sha256(text),
        model_resolved: resolved.id,
        via: 'ollama',
        ms,
        tokens,
        cost_usd: 0,
        spans: [{ name: `chat ${resolved.id} via ollama`, kind: 'chat' }],
        artifacts: []
      });
      appendEvent('run.completed', { model: resolved.id, via: 'ollama', ms, tokens });
      return { ok: true, model: resolved.id, via: 'ollama', ms, tokens, cost_usd: 0, text, receipt: rec.hash };
    } catch (e) {
      appendEvent('run.failed', { model: resolved.id, note: redact((e as Error).message) });
      const rec = appendReceipt('runs', { kind: 'run', subject: `llm ${resolved.id}`, policy: 'auto', status: 'failed', error_class: errClass(undefined, e), ...base, model_resolved: resolved.id, via: 'ollama', spans: [], artifacts: [] });
      return { ok: false, note: redact((e as Error).message), receipt: rec.hash };
    }
  }
  const proxy = process.env.TIMMY_AI_PROXY;
  const key = readApiKey();
  if (!proxy && !key) {
    const rec = appendReceipt('runs', { kind: 'run', subject: `llm ${args.model} DENIED`, policy: 'auto', status: 'denied', error_class: 'no_key', ...base, spans: [], artifacts: [] });
    return { ok: false, note: 'no OPENROUTER_API_KEY in env or .env and no TIMMY_AI_PROXY edge route', receipt: rec.hash };
  }
  const body = JSON.stringify({ model: args.model, messages, temperature: 0.7 });
  try {
    const res = proxy
      ? await fetch(`${proxy}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      : await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'TIMMY' },
        body
      });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const raw = await res.text();
      appendEvent('run.failed', { model: args.model, status: res.status, ms });
      const rec = appendReceipt('runs', { kind: 'run', subject: `llm ${args.model}`, policy: 'auto', status: 'failed', error_class: errClass(res.status), ...base, model_resolved: resolved.id, via: resolved.via, ms, spans: [{ name: `chat ${args.model} via ${resolved.via}`, kind: 'chat' }], artifacts: [] });
      return { ok: false, status: res.status, note: redact(raw.slice(0, 300)), ms, receipt: rec.hash };
    }
    const j = await res.json() as any;
    const text = redact(j?.choices?.[0]?.message?.content ?? '');
    const usage = j?.usage ?? {};
    const rec = appendReceipt('runs', {
      kind: 'run',
      subject: `llm ${args.model}`,
      policy: args.requires_approval ? 'human-gated' : 'auto',
      status: 'ok',
      ...base,
      response_hash: sha256(text),
      model_resolved: resolved.id,
      via: resolved.via,
      ms,
      tokens: usage?.total_tokens ?? 0,
      cost_usd: usage?.cost,
      spans: [{ name: `chat ${args.model} via ${resolved.via}`, kind: 'chat' }],
      artifacts: []
    });
    appendEvent('run.completed', { model: args.model, via: resolved.via, ms, tokens: usage?.total_tokens ?? 0 });
    return { ok: true, model: args.model, via: resolved.via, ms, tokens: usage?.total_tokens ?? 0, cost_usd: usage?.cost ?? 0, text, receipt: rec.hash };
  } catch (e) {
    appendEvent('run.failed', { model: args.model, note: redact((e as Error).message) });
    const rec = appendReceipt('runs', { kind: 'run', subject: `llm ${args.model}`, policy: 'auto', status: 'failed', error_class: errClass(undefined, e), ...base, model_resolved: resolved.id, via: resolved.via, spans: [], artifacts: [] });
    return { ok: false, note: redact((e as Error).message), receipt: rec.hash };
  }
}

async function fusionPlan(_args: Record<string, never>) {
  const judges = [];
  for (const id of JUDGE_CHAIN) {
    const r = await resolveModel(id);
    judges.push({ model: id, via: r.via, ...(r.suggestions ? { suggestions: r.suggestions } : {}) });
  }
  const available = judges.filter(j => j.via !== 'none').map(j => j.model);
  appendEvent('fusion.planned', { available });
  return {
    ok: true,
    chain: JUDGE_CHAIN,
    judges,
    available,
    floor: 'google/gemini-3.7-flash',
    note: 'approval is operator-only: `timmy approve <planHash>` mints a single-use token; bare booleans are ignored everywhere'
  };
}

// ---- timmy_judge_loop: one-command, plan-hash-gated multi-executor judging ----
// Exported so tests and operators hash the IDENTICAL plan shape the server
// binds — no drift between caller and enforcer.
export function judgePlanOf(args: { prompt: string; system?: string; executors: string[]; judge: string; max_spend?: number; tier?: string }) {
  return {
    tool: 'timmy_judge_loop',
    prompt: args.prompt,
    system: args.system ?? null,
    executors: args.executors, // order is bound
    judge: args.judge,
    transport: 'resolved-at-run: openrouter | ollama',
    params: { temperature: 0.7 },
    escalation: { policy: 'local-first', arbitration: 'none-at-v0.5' },
    policy: 'human-gated',
    tier: args.tier ?? 'T0',
    max_spend: args.max_spend ?? 0
  };
}

// v0.5: the approved plan binds EVERYTHING that can drift — system prompt,
// user prompt, executor order, judge, transport resolution, parameters,
// escalation policy, and spend (AgentPass field names: policy/tier/max_spend
// so §7.6 adoption later is a rename, not a migration). Phase-2 args re-hash
// to the same planHash; any drift = different hash = token mismatch = denied.
async function judgeLoop(args: { prompt: string; system?: string; executors?: string[]; judge?: string; approval?: string; max_spend?: number; tier?: string }) {
  const executors = args.executors ?? ['nemotron-3.5-lightning', 'qwen3.8:27b-mlx', 'google/gemini-3.7-flash'];
  const judge = args.judge ?? 'qwen3.8:27b-mlx';
  const max_spend = args.max_spend ?? 0; // default-deny paid spend
  const plan = judgePlanOf({ prompt: args.prompt, system: args.system, executors, judge, max_spend, tier: args.tier });
  const planHash = planHashOf(plan);
  if (!args.approval) {
    return { phase: 'plan', ok: false, needs_approval: true, plan, planHash, note: `operator: \`timmy approve ${planHash}\` (single-use, 5min), then re-invoke with approval:<token>; set max_spend>0 to permit paid executors` };
  }
  const gate = consumeApproval(args.approval, planHash);
  if (!gate.ok) {
    const rec = appendReceipt('runs', { kind: 'run', subject: 'judge loop DENIED', policy: 'human-gated', status: 'denied', error_class: 'approval', plan_hash: planHash, prompt_hash: sha256(args.prompt), spans: [], artifacts: [] });
    return { ok: false, denied: true, planHash, note: gate.note, receipt: rec.hash };
  }
  const resolvedAll = await Promise.all([...executors, judge].map(async m => ({ m, r: await resolveModel(m) })));
  const unresolved = resolvedAll.filter(x => x.r.via === 'none');
  if (unresolved.length > 0) {
    const rec = appendReceipt('runs', { kind: 'run', subject: 'judge loop DENIED (unresolved models)', policy: 'human-gated', status: 'denied', error_class: 'unresolved_model', plan_hash: planHash, prompt_hash: sha256(args.prompt), spans: [], artifacts: [] });
    return { ok: false, denied: true, unresolved: unresolved.map(x => ({ model: x.m, suggestions: x.r.suggestions })), receipt: rec.hash };
  }
  // Default-deny: any paid/remote route with zero approved budget is refused
  // before a single token is spent.
  const paid = resolvedAll.filter(x => x.r.via === 'openrouter');
  if (paid.length > 0 && max_spend <= 0) {
    const rec = appendReceipt('runs', { kind: 'run', subject: 'judge loop DENIED (spend policy)', policy: 'human-gated', status: 'denied', error_class: 'spend_policy', plan_hash: planHash, prompt_hash: sha256(args.prompt), spans: [], artifacts: [] });
    return { ok: false, denied: true, note: `paid routes (${paid.map(x => x.m).join(', ')}) require max_spend > 0 in the approved plan`, receipt: rec.hash };
  }
  const settled = await Promise.allSettled(executors.map(m => llmCall({ model: m, prompt: args.prompt, system: args.system })));
  const results = settled.map((s, i) => s.status === 'fulfilled'
    ? { executor: executors[i], ...(s.value as object) } as any
    : { executor: executors[i], ok: false, error_class: 'executor_threw', note: String((s as PromiseRejectedResult).reason) });
  const successes = results.filter(r => r.ok);
  const failures = results.filter(r => !r.ok);
  let spent = results.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  let judgment: any = null;
  if (successes.length > 0) {
    if (spent > max_spend) {
      const rec = appendReceipt('runs', { kind: 'run', subject: 'judge loop DENIED (overspend before judge)', policy: 'human-gated', status: 'denied', error_class: 'spend_policy', plan_hash: planHash, prompt_hash: sha256(args.prompt), spans: [], artifacts: [] });
      return { ok: false, denied: true, spent, max_spend, executors: results, note: 'executor spend exceeded approved max_spend; judge not called', receipt: rec.hash };
    }
    const jr = await llmCall({
      model: judge,
      prompt: `Executor outputs:\n${successes.map(s => `${s.executor}: ${s.text}`).join('\n\n')}\n\nJudge: pick the best or synthesize. Output ONLY JSON {"verdict":"...","best":"<executor>","notes":"..."}.`,
      system: 'You are a judge. Output ONLY valid JSON.'
    }) as any;
    spent += Number(jr.cost_usd) || 0;
    judgment = { model: judge, ok: jr.ok, text: jr.text, receipt: jr.receipt };
  }
  const childReceipts = [...results.map(r => r.receipt), judgment?.receipt].filter(Boolean) as string[];
  const parent = appendReceipt('runs', {
    kind: 'run',
    subject: `judge loop · ${executors.length} executors · judge ${judge} · ${successes.length} ok / ${failures.length} failed · spent $${spent.toFixed(6)}`,
    policy: 'human-gated',
    tier: plan.tier,
    max_spend,
    cost_usd: spent,
    status: successes.length ? 'ok' : 'failed',
    plan_hash: planHash,
    prompt_hash: sha256(args.prompt),
    child_receipts: childReceipts,
    executors: results.map(r => ({ model: r.model ?? r.executor, ok: r.ok, via: r.via, ms: r.ms, tokens: r.tokens, cost_usd: r.cost_usd, status: r.ok ? 'ok' : 'failed', error_class: r.ok ? undefined : (r.error_class ?? 'executor_failed') })),
    spans: [{ name: `judge loop ${planHash.slice(0, 8)}`, kind: 'invoke_agent' as const }],
    artifacts: []
  } as any);
  appendEvent('judge.completed', { planHash, ok: successes.length, failed: failures.length, spent });
  return { ok: true, planHash, spent, max_spend, executors: results, failures, judgment, child_receipts: childReceipts, receipt: parent.hash };
}

// ---- promo judge loop: local-first ($0), frontier ONLY on low confidence ----
const extractPromoCopy = (html: string): string => {
  const noBlocks = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const text = noBlocks.replace(/<[^>]+>/g, '\n');
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2 && l.length < 120);
  const out: string[] = [];
  for (const l of lines) if (l !== out[out.length - 1]) out.push(l);
  return out.slice(0, 80).join('\n');
};

const grabJSON = (t: string): any => {
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
};

async function promoJudge(args: { comp?: string; threshold?: number }) {
  const threshold = args?.threshold ?? 0.7;
  const studioDir = join(process.cwd(), 'studio');
  const comps = existsSync(studioDir)
    ? readdirSync(studioDir).filter(d => /^timmy-promo-v\d+$/.test(d)).sort()
    : [];
  const comp = args?.comp ?? comps[comps.length - 1];
  const htmlPath = join(studioDir, comp, 'index.html');
  if (!existsSync(htmlPath)) return { ok: false, note: `comp not found: ${comp}` };
  const copy = extractPromoCopy(readFileSync(htmlPath, 'utf8'));
  const judgePrompt = `TIMMY 45s promo comp ${comp}. Visible copy:\n---\n${copy}\n---\nJudge as a conversion marketer AND a trust-skeptic. Score 0-10 (messaging, proof density, honesty). Propose up to 3 beat edits using beat ids: hook1 hook2 turn lanes cost receipt replay envlock clip local connect grammar split lockup end, as {"id","claim"?,"sub"?,"evidence"?}. Output ONLY JSON {"score":n,"confidence":0-1,"edits":[...],"notes":"..."}`;
  const judgeRuns = await Promise.all(['nemotron-3.5-lightning', 'qwen3.8:27b-mlx'].map(async m => {
    const r = await llmCall({ model: m, prompt: judgePrompt, system: 'You are a promo judge. Output ONLY valid JSON.' });
    return { model: m, via: (r as any).via ?? 'none', ok: !!(r as any).ok, ms: (r as any).ms, parsed: (r as any).ok ? grabJSON((r as any).text ?? '') : null };
  }));
  const good = judgeRuns.filter(j => j.ok && j.parsed);
  if (good.length === 0) return { ok: false, note: 'no local judge available — local-first loop refuses to spend', judges: judgeRuns };
  const fuseModel = good.some(j => j.model === 'qwen3.8:27b-mlx') ? 'qwen3.8:27b-mlx' : 'nemotron-3.5-lightning';
  const fusedRun = await llmCall({
    model: fuseModel,
    prompt: `Judge outputs for the same promo:\n${good.map(j => `${j.model}: ${JSON.stringify(j.parsed)}`).join('\n')}\nFuse into ONE JSON {"score":n,"confidence":0-1,"edits":[up to 3, de-duplicated],"notes":"..."}. confidence = how much the judges agree. Output ONLY JSON.`,
    system: 'You are a fusion judge. Output ONLY valid JSON.'
  });
  const fused = (fusedRun as any).ok ? grabJSON((fusedRun as any).text ?? '') : null;
  if (!fused) return { ok: false, note: 'local fusion failed', judges: judgeRuns };
  let escalated = false;
  let arbitrator: string | null = null;
  let final = fused;
  if ((Number(fused.confidence) || 0) < threshold) {
    escalated = true;
    for (const m of ['x-ai/grok-4.6', 'google/gemini-3.7-flash']) {
      const r = await llmCall({ model: m, prompt: `Local judges fused this promo verdict at confidence ${fused.confidence} (< ${threshold}). Arbitrate: keep, cut, or sharpen each edit.\n${JSON.stringify(fused)}\nOutput ONLY JSON {"score":n,"confidence":0-1,"edits":[...],"notes":"..."}.`, system: 'You are a frontier arbitration judge. Output ONLY valid JSON.' });
      const p = (r as any).ok ? grabJSON((r as any).text ?? '') : null;
      if (p) { final = p; arbitrator = m; break; }
    }
  }
  const rec = appendReceipt('runs', {
    kind: 'run',
    subject: `promo judge ${comp} · local-first · escalated=${escalated}`,
    policy: 'auto',
    spans: [
      ...good.map(j => ({ name: `judge ${j.model} (local $0)`, kind: 'chat' as const })),
      { name: `fusion ${fuseModel} (local $0)`, kind: 'chat' as const },
      ...(arbitrator ? [{ name: `arbitration ${arbitrator}`, kind: 'chat' as const }] : [])
    ],
    cost_usd: escalated ? undefined : 0,
    artifacts: [`studio/${comp}/index.html`]
  });
  appendEvent('promo.judged', { comp, score: final.score, confidence: final.confidence, escalated });
  return {
    ok: true, comp,
    judges: good.map(j => ({ model: j.model, via: j.via, score: j.parsed.score, ms: j.ms })),
    local_fusion: { model: fuseModel, score: fused.score, confidence: fused.confidence },
    escalated, arbitrator,
    final,
    receipt: rec.hash,
    apply_hint: 'human reviews final.edits, then timmy_promo_apply with the chosen beats'
  };
}

// ---- external MCP lanes via mcporter: allyson (animated SVG) + apify ----
// Every use is logged to .timmy/runs/mcp-*.log and sealed as a receipt, so the
// creative loop (prompt → run → review log → vision-compare → re-prompt) has
// the same provenance as every other TIMMY lane.
function runMcporter(opts: {
  lane: string;
  mode: 'stdio' | 'http';
  stdioArgs?: string[];            // args after the npx command
  httpUrl?: string;
  httpHeaderEnv?: string;          // token sourced from env at spawn
  headerStyle?: 'bearer' | 'x-api-key';
  selector: string;                // <serverName>.<tool>
  args: Record<string, unknown>;
  logName: string;
}) {
  const logPath = join(process.cwd(), '.timmy', 'runs', `mcp-${opts.logName}-${Date.now()}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const margs = ['call'];
  if (opts.mode === 'stdio') {
    margs.push('--stdio', 'npx');
    for (const a of opts.stdioArgs ?? []) margs.push('--stdio-arg', a);
  } else {
    margs.push('--http-url', opts.httpUrl ?? '');
    const tok = process.env[opts.httpHeaderEnv ?? ''] ?? '';
    if (tok) margs.push('--header', opts.headerStyle === 'x-api-key' ? `x-api-key=${tok}` : `Authorization=Bearer ${tok}`);
  }
  margs.push(opts.selector);
  for (const [k, v] of Object.entries(opts.args)) margs.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const child = spawnSync('mcporter', margs, { encoding: 'utf8', timeout: 300000 });
  const out = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
  writeFileSync(logPath, out);
  return { ok: child.status === 0, log: logPath, out: (child.stdout ?? '').slice(0, 2000), note: child.status !== 0 ? redact((child.stderr ?? child.stdout ?? '').slice(0, 300)) : undefined };
}

async function allysonRun(args: { prompt: string; svg_path: string; output_path: string }) {
  const key = process.env.ALLYSON_API_KEY ?? process.env.API_KEY ?? '';
  if (!key) return { ok: false, needs_key: 'ALLYSON_API_KEY — sign up at allyson.ai; the lane is wired, generation needs the key' };
  const r = runMcporter({
    lane: 'allyson', mode: 'stdio',
    stdioArgs: ['allyson-mcp', '--api-key', key],
    selector: 'npx.generate_svg_animation',
    args: { prompt: args.prompt, svg_path: args.svg_path, output_path: args.output_path },
    logName: 'allyson'
  });
  appendReceipt('runs', {
    kind: 'run',
    subject: `allyson svg animation · ${args.prompt.slice(0, 60)}`,
    policy: 'auto',
    spans: [{ name: 'allyson.generate_svg_animation (mcporter)', kind: 'execute_tool' }],
    cost_usd: undefined,
    artifacts: r.ok && existsSync(args.output_path) ? [args.output_path] : []
  });
  appendEvent(r.ok ? 'allyson.done' : 'allyson.failed', { log: r.log });
  return { ...r, review: `read the usage log (prompt/result/traffic) at ${r.log}; vision-compare source vs output, then re-prompt` };
}

async function apifyRun(args: { tool: string; args?: Record<string, unknown> }) {
  const tok = process.env.APIFY_API_TOKEN ?? process.env.APIFY_API_KEY ?? '';
  if (!tok) return { ok: false, needs_key: 'APIFY_API_TOKEN from https://console.apify.com/account/integrations' };
  const r = runMcporter({
    lane: 'apify', mode: 'http',
    httpUrl: 'https://mcp.apify.com', httpHeaderEnv: process.env.APIFY_API_TOKEN ? 'APIFY_API_TOKEN' : 'APIFY_API_KEY',
    selector: `mcp-apify-com.${args.tool}`,
    args: args.args ?? {},
    logName: `apify-${args.tool}`
  });
  appendReceipt('runs', {
    kind: 'run',
    subject: `apify ${args.tool}`,
    policy: 'auto',
    spans: [{ name: `apify.${args.tool} (mcporter)`, kind: 'execute_tool' }],
    cost_usd: undefined,
    artifacts: []
  });
  appendEvent(r.ok ? 'apify.done' : 'apify.failed', { tool: args.tool, log: r.log });
  return r;
}

// Optional helper lane: 3minapi = no-code API builder (create/test/deploy data
// capture endpoints, collaborator keys, webhooks). Helps with apis/mcps work;
// never on the critical path.
async function threeminapiRun(args: { tool: string; args?: Record<string, unknown> }) {
  const tok = process.env.THREEMINAPI_KEY ?? '';
  if (!tok) return { ok: false, needs_key: 'THREEMINAPI_KEY (3minapi.com) — optional helper lane' };
  const r = runMcporter({
    lane: '3minapi', mode: 'http',
    httpUrl: 'https://3minapi.com/api/mcp', httpHeaderEnv: 'THREEMINAPI_KEY', headerStyle: 'x-api-key',
    // config-defined server name (config/mcporter.json) — slug-independent
    selector: `3minapi.${args.tool}`,
    args: args.args ?? {},
    logName: `3minapi-${args.tool}`
  });
  appendReceipt('runs', {
    kind: 'run',
    subject: `3minapi ${args.tool}`,
    policy: 'auto',
    spans: [{ name: `3minapi.${args.tool} (mcporter)`, kind: 'execute_tool' }],
    cost_usd: undefined,
    artifacts: []
  });
  appendEvent(r.ok ? '3minapi.done' : '3minapi.failed', { tool: args.tool, log: r.log });
  return r;
}

const replaceInnerText = (html: string, id: string, text: string): string => {
  const re = new RegExp('(id="' + id + '"[^>]*>)([^<]*)', 'g');
  return html.replace(re, (_m, pre, old) => pre + text);
};

function genRun(args: { provider?: string; model?: string; prompt: string; kind?: string }) {
  const providerId = args.provider ?? 'openrouter';
  const prov = GENERATION_PROVIDERS.find(p => p.id === providerId)
    ?? { id: providerId, label: providerId, modelId: args.model ?? '', kind: (args.kind ?? 'text') as any, transport: 'openrouter' as any };
  const rec = recordGeneration({
    prompt: args.prompt,
    provider: prov.id,
    model: args.model ?? prov.modelId ?? '',
    kind: (args.kind ?? prov.kind ?? 'text') as any,
    transport: (prov.transport ?? 'openrouter') as any,
    status: 'running'
  });
  const genDir = locateGenAgent();
  const sargs = buildGenAgentArgs(prov as any, args.prompt);
  const log = join(process.cwd(), '.timmy', 'runs', `${rec.id}.log`);
  if (!genDir || !sargs) {
    updateGeneration(rec.id, { status: 'failed' });
    return { id: rec.id, status: 'failed', note: 'gen agent bridge unavailable' };
  }
  launchDetached(genDir, sargs as string[], log);
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const txt = existsSync(log) ? readFileSync(log, 'utf8') : '';
    if (txt.includes('EXIT=')) break;
    sleepSync(2000);
  }
  const txt = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const artifact = extractArtifactFromLog(txt);
  const ok = /EXIT=0/.test(txt);
  updateGeneration(rec.id, { status: ok ? 'done' : 'failed', ...(artifact ? { artifact } : {}) });
  return { id: rec.id, status: ok ? 'done' : 'failed', artifact, logTail: txt.split('\n').slice(-4) };
}

function promoApply(args: { beats: { id: string; claim?: string; sub?: string; evidence?: string }[]; from?: string }) {
  const fromV = args.from ?? 'timmy-promo-v8';
  const src = join(process.cwd(), 'studio', fromV, 'index.html');
  const n = Number((fromV.match(/v(\d+)$/) ?? [])[1] ?? 8);
  const outDir = join(process.cwd(), 'studio', `timmy-promo-v${n + 1}`);
  if (!existsSync(src)) return { ok: false, note: `${fromV} comp missing` };
  mkdirSync(outDir, { recursive: true });
  let html = readFileSync(src, 'utf8');
  const idMap: Record<string, { claim?: string; sub?: string; ev?: string }> = {
    hook1: { claim: 'h1t' }, hook2: { claim: 'h2' }, turn: { claim: 't1' },
    lanes: { claim: 'c1', sub: 'c1s', ev: 'c1e' }, cost: { claim: 'c2', sub: 'c2s', ev: 'c2e' },
    receipt: { claim: 'c3', ev: 'c3e' }, replay: { claim: 'c4', ev: 'c4e' }, envlock: { claim: 'c5', ev: 'c5e' },
    clip: { claim: 'c6', sub: 'c6s', ev: 'c6e' }, local: { claim: 'c7', sub: 'c7s', ev: 'c7e' },
    connect: { claim: 'c8', ev: 'c8e' }, grammar: { claim: 'c9', sub: 'c9s' },
    split: { claim: 'c10' }, lockup: { claim: 'l2' }, end: { ev: 'e2' }
  };
  let applied = 0;
  for (const b of args.beats) {
    const m = idMap[b.id];
    if (!m) continue;
    if (b.claim && m.claim) { html = replaceInnerText(html, m.claim, b.claim); applied++; }
    if (b.sub && m.sub) { html = replaceInnerText(html, m.sub, b.sub); applied++; }
    if (b.evidence && m.ev) { html = replaceInnerText(html, m.ev, b.evidence); applied++; }
  }
  writeFileSync(join(outDir, 'index.html'), html);
  for (const f of ['demo-lanes.mp4', 'demo-replay.mp4', 'bed.m4a']) {
    const s = join(dirname(src), f);
    if (existsSync(s)) copyFileSync(s, join(outDir, f));
  }
  return { ok: true, applied, out: join(outDir, 'index.html') };
}

const call = (name: string, args: any): unknown => {
  if (name.startsWith('timmy_vision_')) return callVisionTool(name, args);
  switch (name) {
    case 'timmy_env_lock': return captureEnvLock();
    case 'timmy_events_tail': return readEvents(Number(args?.n ?? 10));
    case 'timmy_receipt_verify': return verifyChain(String(args?.stream ?? 'runs'));
    case 'timmy_clip_replay': return replayFromEdl(String(args?.jobId ?? ''));
    case 'timmy_gen_run': return genRun(args ?? { prompt: '' });
    case 'timmy_promo_apply': return promoApply(args ?? { beats: [] });
    case 'timmy_llm_call': return llmCall(args ?? { model: '', prompt: '' });
    case 'timmy_fusion_plan': return fusionPlan(args ?? {});
    case 'timmy_promo_judge': return promoJudge(args ?? {});
    case 'timmy_allyson_run': return allysonRun(args ?? { prompt: '', svg_path: '', output_path: '' });
    case 'timmy_apify_run': return apifyRun(args ?? { tool: '' });
    case 'timmy_3minapi_run': return threeminapiRun(args ?? { tool: '' });
    case 'timmy_judge_loop': return judgeLoop(args ?? { prompt: '' });
    case 'timmy_openhands_run': return runOpenHandsTask((args ?? {}) as OpenHandsOpts);
    case 'timmy_roboflow_run': return roboflowRun((args ?? {}) as RoboflowReq);
    case 'timmy_oapi_run': return oapiRun((args ?? {}) as OapiReq);
    case 'timmy_list_lanes': return { ok: true, lanes: listLanes() };
    case 'timmy_plan_dispatch': return createPlan((args?.plan ?? {}) as DispatchPlan);
    case 'timmy_mission_compile': return compileMissionMap((args?.doc ?? { nodes: [], edges: [] }) as MissionMapDoc, typeof args?.repo_root === 'string' ? { repoRoot: args.repo_root } : {});
    case 'timmy_dispatch_plan': {
      const id = String(args?.id ?? '');
      if (args?.approval) {
        const armed = armPlan(id, String(args.approval));
        if (!armed.ok) return armed;
      }
      return dispatchPlan(id);
    }
    case 'timmy_tail_lane': return tailLane(String(args?.id ?? ''));
    case 'timmy_pause_or_cancel_lane': return pauseOrCancelLane(String(args?.id ?? ''), args?.action === 'hold' ? 'hold' : 'cancel');
    case 'timmy_collect_run': return collectRun(String(args?.id ?? ''));
    default: throw new Error(`unknown tool ${name}`);
  }
};

// Headless sessions get eyes: the companion auto-pops once per machine
// session (reused if already up; TIMMY_LOGS_OPEN=0 opts out of the pop).
import { ensureLogCompanion } from '../utils/logserver.js';
import { pathToFileURL } from 'url';

export function startMcpServer(): void {
  ensureLogCompanion().catch(() => {});
  serveStdio();
}

function serveStdio(): void {
let buf = '';
process.stdin.on('data', d => {
  buf += d.toString();
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'timmy', version: '0.4.0' } } }) + '\n');
    } else if (msg.method === 'notifications/initialized') {
      // no response for notifications
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }) + '\n');
    } else if (msg.method === 'tools/call') {
      (async () => {
        try {
          const result = await call(msg.params?.name, msg.params?.arguments);
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }) + '\n');
        } catch (e) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true } }) + '\n');
        }
      })();
    }
  }
});
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startMcpServer();

export { llmCall, judgeLoop, redact };
